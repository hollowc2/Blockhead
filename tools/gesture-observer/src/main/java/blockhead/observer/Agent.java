package blockhead.observer;

import java.io.IOException;
import java.io.InputStream;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.ProtectionDomain;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * -javaagent:gesture-observer.jar=socket=/private/dir/observer.sock,player=CobbleBob
 *
 * Patches the 1.21.4 entry hooks as classes load, then serves a private
 * Unix-domain control socket (owner-only 0700 directory and 0600 socket file):
 *   STATUS        one status line
 *   ARM <seconds> status line, then typed records until the bound, DISARM or EOF
 *   UNHOOK        restore original bytecode for every patched class; patching stops
 * Nothing is written to disk and no game command or packet is ever sent.
 */
public final class Agent {
    public static final String VERSION = "1";
    public static final int MAX_ARM_SECONDS = 300;
    private static final Map<String, List<ClassPatcher.Hook>> HOOKS = Hooks.byOwner();
    private static final Map<String, String> installed = new ConcurrentHashMap<>();
    private static volatile String mcVersion = null;
    private static volatile boolean versionOk = false;
    private static volatile boolean unhooked = false;
    private static volatile String failure = null;
    private static final AtomicBoolean busy = new AtomicBoolean();
    private static Instrumentation instrumentation;

    private Agent() {}

    /**
     * Never throws: an exception here would abort JVM startup and take the
     * Minecraft server down with it. Any setup failure leaves the agent inert
     * (no transformer, no socket) and prints one line to stderr.
     */
    public static void premain(String args, Instrumentation inst) {
        try {
            Map<String, String> options = new TreeMap<>();
            for (String part : (args == null ? "" : args).split(",")) {
                int eq = part.indexOf('=');
                if (eq > 0) options.put(part.substring(0, eq), part.substring(eq + 1));
            }
            String player = options.get("player"), socket = options.get("socket");
            if (player == null || !player.matches("[A-Za-z0-9_]{3,16}") || socket == null) throw new IllegalArgumentException("needs socket=<path>,player=<name>");
            ServerSocketChannel server = openSocket(Path.of(socket));
            instrumentation = inst;
            Recorder.configure(player);
            inst.addTransformer(new Transformer(), true);
            Thread accept = new Thread(() -> serve(server), "blockhead-gesture-observer");
            accept.setDaemon(true);
            accept.start();
        } catch (Throwable t) {
            System.err.println("blockhead gesture observer disabled: " + t.getClass().getSimpleName() + ": " + t.getMessage());
        }
    }

    /** The socket's directory must be a real directory owned by this user with mode 0700. */
    static ServerSocketChannel openSocket(Path path) throws IOException {
        // Linux sun_path is 108 bytes including the terminator.
        if (path.toString().getBytes(StandardCharsets.UTF_8).length > 100) throw new IOException("socket path longer than 100 bytes");
        Path dir = path.toAbsolutePath().getParent();
        if (!Files.exists(dir, LinkOption.NOFOLLOW_LINKS)) Files.createDirectories(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) throw new IOException("socket parent is not a directory");
        if (!Files.getOwner(dir, LinkOption.NOFOLLOW_LINKS).getName().equals(System.getProperty("user.name"))) throw new IOException("socket directory owned by another user");
        if (!PosixFilePermissions.toString(Files.getPosixFilePermissions(dir, LinkOption.NOFOLLOW_LINKS)).equals("rwx------")) throw new IOException("socket directory must be mode 0700");
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(path)) throw new IOException("refusing to replace a non-socket at the socket path");
            Files.delete(path);
        }
        ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(path));
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        return server;
    }

    static String status() {
        StringBuilder hooks = new StringBuilder("{");
        boolean first = true;
        for (ClassPatcher.Hook h : Hooks.ALL) {
            if (!first) hooks.append(',');
            first = false;
            hooks.append('"').append(h.id()).append("\":\"").append(unhooked ? "removed" : installed.getOrDefault(h.id(), "not_loaded")).append('"');
        }
        hooks.append('}');
        boolean complete = !unhooked && versionOk && Hooks.ALL.stream().allMatch(h -> "installed".equals(installed.get(h.id())));
        return Recorder.header(0, "status") + ",\"agent\":\"" + VERSION + "\",\"mc\":" + (mcVersion == null ? "null" : "\"" + mcVersion + "\"")
            + ",\"supported\":" + versionOk + ",\"complete\":" + complete + ",\"unhooked\":" + unhooked
            + ",\"failure\":" + (failure == null ? "null" : "\"" + failure + "\"") + ",\"hooks\":" + hooks + "}";
    }

    private static void serve(ServerSocketChannel server) {
        while (true) {
            try {
                SocketChannel client = server.accept();
                Thread session = new Thread(() -> session(client), "blockhead-gesture-observer-session");
                session.setDaemon(true);
                session.start();
            } catch (IOException e) { failure = "accept"; return; }
        }
    }

    private static void session(SocketChannel client) {
        try (client) {
            String command = readLine(client, 64);
            if (command == null) return;
            if (command.equals("STATUS")) { write(client, status()); return; }
            if (command.equals("UNHOOK")) { unhook(); write(client, status()); return; }
            if (command.startsWith("ARM ")) {
                int seconds;
                try { seconds = Integer.parseInt(command.substring(4)); } catch (NumberFormatException e) { write(client, "{\"error\":\"bad_arm\"}"); return; }
                if (seconds < 1 || seconds > MAX_ARM_SECONDS) { write(client, "{\"error\":\"bad_arm\"}"); return; }
                if (!busy.compareAndSet(false, true)) { write(client, "{\"error\":\"busy\"}"); return; }
                try { stream(client, seconds); } finally { Recorder.disarm(); busy.set(false); }
                return;
            }
            write(client, "{\"error\":\"unknown_command\"}");
        } catch (IOException | RuntimeException ignored) { }
    }

    private static void stream(SocketChannel client, int seconds) throws IOException {
        write(client, status());
        AtomicBoolean stop = new AtomicBoolean();
        Thread reader = new Thread(() -> {
            try { String line; while ((line = readLine(client, 64)) != null) if (line.equals("DISARM")) break; }
            catch (IOException ignored) { }
            stop.set(true);
        }, "blockhead-gesture-observer-reader");
        reader.setDaemon(true);
        Recorder.arm();
        reader.start();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        String reason = "timeout";
        try {
            while (System.nanoTime() < deadline) {
                if (stop.get()) { reason = "client"; break; }
                if (unhooked) { reason = "unhooked"; break; }
                String line = Recorder.QUEUE.poll(100, TimeUnit.MILLISECONDS);
                if (line != null) write(client, line);
                else Recorder.emitOverflow();
            }
        } catch (InterruptedException e) { reason = "interrupted"; Thread.currentThread().interrupt(); }
        Recorder.armed = false;
        String line;
        while ((line = Recorder.QUEUE.poll()) != null) write(client, line);
        write(client, Recorder.header(Recorder.seq() + 1, "end") + ",\"reason\":\"" + reason + "\",\"dropped\":" + Recorder.dropped()
            + ",\"faults\":" + Recorder.faults() + ",\"hookCalls\":" + Recorder.CALLS.sum() + ",\"hookNanos\":" + Recorder.NANOS.sum() + "}");
    }

    /** Restores the original bytecode of every patched class. Later class loads are not patched. */
    static synchronized void unhook() {
        if (unhooked) return;
        unhooked = true;
        Recorder.disarm();
        Set<String> owners = HOOKS.keySet();
        List<Class<?>> targets = new java.util.ArrayList<>();
        for (Class<?> c : instrumentation.getAllLoadedClasses()) if (owners.contains(c.getName().replace('.', '/'))) targets.add(c);
        try { if (!targets.isEmpty()) instrumentation.retransformClasses(targets.toArray(Class<?>[]::new)); }
        catch (Throwable t) { failure = "unhook"; }
    }

    private static String readLine(SocketChannel channel, int max) throws IOException {
        ByteBuffer one = ByteBuffer.allocate(1);
        StringBuilder line = new StringBuilder();
        while (true) {
            one.clear();
            if (channel.read(one) <= 0) return null;
            char c = (char) one.get(0);
            if (c == '\n') return line.toString();
            if (line.length() >= max) return null;
            line.append(c);
        }
    }

    private static void write(SocketChannel channel, String line) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap((line + "\n").getBytes(StandardCharsets.UTF_8));
        while (buffer.hasRemaining()) channel.write(buffer);
    }

    static final class Transformer implements ClassFileTransformer {
        @Override
        public byte[] transform(Module module, ClassLoader loader, String name, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
            if (name == null || unhooked) return null;
            List<ClassPatcher.Hook> hooks = HOOKS.get(name);
            if (hooks == null || loader == null) return null;
            try {
                if (mcVersion == null) checkVersion(loader);
                if (!versionOk) { for (ClassPatcher.Hook h : hooks) installed.put(h.id(), "unsupported_version"); return null; }
                ClassPatcher.Result result = ClassPatcher.patch(bytes, hooks);
                for (ClassPatcher.Hook h : hooks) installed.put(h.id(), result.patched().contains(h.id()) ? "installed" : "missing");
                return result.bytes();
            } catch (Throwable t) {
                for (ClassPatcher.Hook h : hooks) installed.put(h.id(), "error");
                failure = "patch:" + name;
                return null;
            }
        }
    }

    private static synchronized void checkVersion(ClassLoader loader) throws IOException {
        if (mcVersion != null) return;
        try (InputStream in = loader.getResourceAsStream("version.json")) {
            String json = in == null ? "" : new String(in.readAllBytes(), StandardCharsets.UTF_8);
            java.util.regex.Matcher id = java.util.regex.Pattern.compile("\"id\"\\s*:\\s*\"([^\"]{1,32})\"").matcher(json);
            java.util.regex.Matcher protocol = java.util.regex.Pattern.compile("\"protocol_version\"\\s*:\\s*(\\d{1,6})").matcher(json);
            String version = id.find() ? id.group(1) : "unknown";
            versionOk = version.equals(Hooks.MC_VERSION) && protocol.find() && Integer.parseInt(protocol.group(1)) == Hooks.MC_PROTOCOL;
            mcVersion = version.replaceAll("[^0-9A-Za-z._-]", "");
        }
    }
}
