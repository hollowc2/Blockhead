package blockhead.observer;

import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.jar.JarFile;

/**
 * Plain-Java self-test (no test framework on the server image).
 *   java -cp build/classes:build/test-classes blockhead.observer.SelfTest [nested server-1.21.4.jar]
 * Patched fixtures are defined in a fresh loader, so the JVM verifier checks
 * every rewritten StackMapTable before the methods run.
 */
public final class SelfTest {
    static final List<String> calls = new ArrayList<>();
    public static void enter1(Object a) { calls.add(String.valueOf(a)); }
    public static void enter2(Object a, Object b) { calls.add(a + "|" + b); }
    public static void enter3(Object a, Object b, Object c) { calls.add(a + "|" + b + "|" + c); }

    private static int failures = 0, checks = 0;
    private static void check(boolean ok, String what) { checks++; if (!ok) { failures++; System.out.println("FAIL " + what); } }

    static final class Loader extends ClassLoader {
        private final String name; private final byte[] bytes;
        Loader(String name, byte[] bytes) { super(SelfTest.class.getClassLoader()); this.name = name; this.bytes = bytes; }
        @Override protected Class<?> loadClass(String n, boolean resolve) throws ClassNotFoundException {
            if (!n.equals(name)) return super.loadClass(n, resolve);
            synchronized (getClassLoadingLock(n)) {
                Class<?> c = findLoadedClass(n);
                return c != null ? c : defineClass(n, bytes, 0, bytes.length);
            }
        }
    }

    private static byte[] read(Class<?> c) throws Exception {
        try (InputStream in = c.getResourceAsStream(c.getSimpleName() + ".class")) { return in.readAllBytes(); }
    }

    public static void main(String[] args) throws Exception {
        patcher();
        slots();
        recorder();
        if (args.length > 0) minecraft(args[0]);
        System.out.println((failures == 0 ? "PASS" : "FAILED") + " " + (checks - failures) + "/" + checks + " checks on Java " + Runtime.version());
        if (failures > 0) System.exit(1);
    }

    static void patcher() throws Exception {
        String owner = "blockhead/observer/Fixture", rec = "blockhead/observer/SelfTest";
        List<ClassPatcher.Hook> hooks = List.of(
            new ClassPatcher.Hook("table", owner, "table", "(Ljava/lang/Object;I)Ljava/lang/String;", new int[]{0, 1}, rec, "enter2"),
            new ClassPatcher.Hook("lookup", owner, "lookup", "(Ljava/lang/Object;I)Ljava/lang/String;", new int[]{1}, rec, "enter1"),
            new ClassPatcher.Hook("handler", owner, "handler", "(Ljava/lang/Object;Ljava/lang/String;)I", new int[]{1, 2}, rec, "enter2"),
            new ClassPatcher.Hook("loop", owner, "loop", "(Ljava/lang/Object;JD)J", new int[]{1}, rec, "enter1"),
            new ClassPatcher.Hook("uninitialized", owner, "uninitialized", "(Ljava/lang/Object;Z)Lblockhead/observer/Fixture;", new int[]{0, 1}, rec, "enter2"),
            new ClassPatcher.Hook("statics", owner, "statics", "(Ljava/lang/Object;JLjava/lang/Object;)Ljava/lang/String;", new int[]{0, 3}, rec, "enter2"),
            new ClassPatcher.Hook("wide", owner, "wideLocals", "(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)I", new int[]{3, 4, 5}, rec, "enter3"),
            new ClassPatcher.Hook("absent", owner, "missing", "()V", new int[]{0}, rec, "enter1"));
        ClassPatcher.Result result = ClassPatcher.patch(read(Fixture.class), hooks);
        check(result.patched().equals(java.util.Set.of("table", "lookup", "handler", "loop", "uninitialized", "statics", "wide")), "patched set " + result.patched());
        Class<?> patched = new Loader("blockhead.observer.Fixture", result.bytes()).loadClass("blockhead.observer.Fixture");
        check(patched != Fixture.class, "fresh class");
        Object o = patched.getConstructor(String.class).newInstance("L");
        Fixture plain = new Fixture("L");
        Method table = patched.getMethod("table", Object.class, int.class), lookup = patched.getMethod("lookup", Object.class, int.class);
        for (int n = -1; n <= 4; n++) check(table.invoke(o, "t", n).equals(plain.table("t", n)), "table " + n);
        for (int n : new int[]{-1000, 7, 100000, 3}) check(lookup.invoke(o, "k", n).equals(plain.lookup("k", n)), "lookup " + n);
        Method handler = patched.getMethod("handler", Object.class, String.class);
        check(handler.invoke(o, "h", "12").equals(12) && handler.invoke(o, "h", "x").equals(-1), "handler");
        try { handler.invoke(o, "h", null); check(false, "finally throws"); } catch (java.lang.reflect.InvocationTargetException e) { check(e.getCause() instanceof IllegalStateException, "finally throws"); }
        check(patched.getMethod("loop", Object.class, long.class, double.class).invoke(o, "l", 5L, 2.5).equals(plain.loop("l", 5, 2.5)), "loop");
        Object made = patched.getMethod("uninitialized", Object.class, boolean.class).invoke(o, "u", true);
        check("yes".equals(made.getClass().getMethod("label").invoke(made)), "uninitialized");
        check(patched.getMethod("statics", Object.class, long.class, Object.class).invoke(null, "a", 9L, "b").equals("a:9:b"), "statics");
        check(patched.getMethod("wideLocals", Object.class, Object.class, Object.class, Object.class, Object.class).invoke(o, "a", "b", "c", "d", "e").equals(plain.wideLocals("a", "b", "c", "d", "e")), "wide");
        check(calls.contains("t") || calls.stream().anyMatch(c -> c.endsWith("|t")), "receiver and argument passed");
        check(calls.contains("k") && calls.contains("h|12") && calls.contains("l") && calls.contains("a|b") && calls.contains("c|d|e"), "arguments " + calls);
        check(calls.stream().filter(c -> c.equals("u") || c.endsWith("|u")).count() == 1, "one call per invocation");
        // Patching is deterministic and idempotent in its constant pool use.
        check(java.util.Arrays.equals(result.bytes(), ClassPatcher.patch(read(Fixture.class), hooks).bytes()), "deterministic");
        check(ClassPatcher.patch(read(Fixture.class), List.of(hooks.get(7))).bytes() == null, "no match leaves the class untouched");
        // A hook asking for a primitive local is refused rather than loading it as a reference.
        check(ClassPatcher.patch(read(Fixture.class), List.of(new ClassPatcher.Hook("primitive", owner, "loop", "(Ljava/lang/Object;JD)J", new int[]{2}, rec, "enter1"))).bytes() == null, "primitive slot refused");
    }

    static void slots() {
        check(java.util.Arrays.equals(ClassPatcher.parameterSlots("(Ljava/lang/Object;JD[[ILjava/lang/String;)V", false), new int[]{0, 1, 2, 4, 6, 7}), "instance slots");
        check(java.util.Arrays.equals(ClassPatcher.parameterSlots("(JLjava/lang/Object;)V", true), new int[]{0, 2}), "static slots");
    }

    static void recorder() {
        Recorder.disarm();
        Recorder.emit("effect", "\"effect\":\"x\"");
        check(Recorder.QUEUE.isEmpty(), "disarmed emits nothing");
        Recorder.arm();
        for (int i = 0; i < Recorder.QUEUE_CAPACITY + 10; i++) Recorder.emit("effect", "\"n\":" + i);
        check(Recorder.QUEUE.size() == Recorder.QUEUE_CAPACITY && Recorder.dropped() == 10, "bounded queue counts drops");
        check(Recorder.seq() == Recorder.QUEUE_CAPACITY + 10, "dropped records still consume sequence numbers");
        Recorder.emitOverflow();
        check(Recorder.dropped() == 10, "overflow waits for room");
        Recorder.QUEUE.clear();
        Recorder.emitOverflow();
        String overflow = Recorder.QUEUE.poll();
        check(overflow != null && overflow.contains("\"type\":\"overflow\"") && overflow.contains("\"dropped\":10") && Recorder.dropped() == 0, "overflow explained in-band");
        String first = null;
        Recorder.arm();
        Recorder.emit("effect", "\"effect\":\"chat\"");
        first = Recorder.QUEUE.poll();
        check(first != null && first.contains("\"seq\":1,") && first.contains("\"run\":\"" + Recorder.RUN + "\""), "re-arm restarts sequence " + first);
        // Hooks ignore everything that is not Bob, and never touch arguments when disarmed.
        Recorder.swing(new Object(), null); Recorder.attack(new Object(), null); Recorder.inbound(new Object(), new Object());
        check(Recorder.QUEUE.isEmpty(), "non-target objects produce no records");
        Recorder.disarm();
        check(Recorder.QUEUE.isEmpty() && !Recorder.armed, "disarm clears");
    }

    /** Every 1.21.4 hook resolves to exactly one method in the real server classes and patches cleanly. */
    static void minecraft(String jarPath) throws Exception {
        try (JarFile jar = new JarFile(jarPath)) {
            for (Map.Entry<String, List<ClassPatcher.Hook>> e : Hooks.byOwner().entrySet()) {
                var entry = jar.getJarEntry(e.getKey() + ".class");
                check(entry != null, "class " + e.getKey());
                if (entry == null) continue;
                byte[] bytes;
                try (InputStream in = jar.getInputStream(entry)) { bytes = in.readAllBytes(); }
                ClassPatcher.Result r = ClassPatcher.patch(bytes, e.getValue());
                for (ClassPatcher.Hook h : e.getValue()) check(r.patched().contains(h.id()), "hook " + h.id());
            }
            for (String obf : Hooks.SERVERBOUND.keySet()) check(jar.getJarEntry(obf + ".class") != null, "packet class " + obf);
            try (InputStream in = jar.getInputStream(jar.getJarEntry("version.json"))) {
                String v = new String(in.readAllBytes());
                check(v.contains("\"id\": \"1.21.4\"") && v.contains("\"protocol_version\": 769"), "version.json");
            }
        }
    }
}
