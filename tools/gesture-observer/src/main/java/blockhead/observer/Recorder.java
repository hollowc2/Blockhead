package blockhead.observer;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.atomic.LongAdder;

/**
 * Static targets of the injected entry calls. Loaded from the bootstrap class
 * path so the server's own class loader resolves it.
 *
 * Disarmed, each hook costs one volatile read (plus a counter for the tick hook).
 * Armed, only Bob's connection/entity produce records: fixed typed fields, no
 * chat text, no other player's identity, pose or packets. Collection never calls
 * a method that sends packets or mutates game state; it only reads fields and
 * side-effect-free getters.
 */
public final class Recorder {
    public static final String HELLO = "Hello, everyone!";
    public static final int QUEUE_CAPACITY = 8192;
    static final String RUN = UUID.randomUUID().toString();

    private static final Object LOCK = new Object();
    static volatile boolean armed;
    private static volatile String target = "";
    private static volatile Object server;
    private static volatile Object bobPlayer;
    private static volatile Object bobConnection;
    private static volatile long tick;
    private static volatile int connections;
    private static long seq;
    private static long dropped;
    private static long faults;
    static final BlockingQueue<String> QUEUE = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    static final LongAdder CALLS = new LongAdder();
    static final LongAdder NANOS = new LongAdder();

    private Recorder() {}

    static void configure(String player) { target = player; }

    /** Starts a fresh armed interval; the caller drains QUEUE. */
    static void arm() {
        synchronized (LOCK) {
            QUEUE.clear(); seq = 0; dropped = 0; faults = 0;
            CALLS.reset(); NANOS.reset();
            armed = true;
        }
    }
    static void disarm() {
        synchronized (LOCK) { armed = false; QUEUE.clear(); bobPlayer = null; bobConnection = null; }
    }
    static long dropped() { synchronized (LOCK) { return dropped; } }
    static long faults() { synchronized (LOCK) { return faults; } }
    static long seq() { synchronized (LOCK) { return seq; } }

    static String header(long s, String type) {
        return "{\"v\":1,\"run\":\"" + RUN + "\",\"seq\":" + s + ",\"tick\":" + tick + ",\"ms\":" + System.currentTimeMillis() + ",\"type\":\"" + type + "\"";
    }

    /** Sequence numbers are assigned in queue order; a full queue leaves a gap and counts the drop. */
    static void emit(String type, String fields) {
        synchronized (LOCK) {
            if (!armed) return;
            long s = ++seq;
            String line = header(s, type) + (fields.isEmpty() ? "" : "," + fields) + "}";
            if (!QUEUE.offer(line)) dropped++;
        }
    }
    /** Called by the writer once the queue has room again, so the gap is explained in-band. */
    static void emitOverflow() {
        synchronized (LOCK) {
            if (!armed || dropped == 0) return;
            long s = ++seq;
            if (QUEUE.offer(header(s, "overflow") + ",\"dropped\":" + dropped + "}")) dropped = 0;
        }
    }
    private static void fault(String where) {
        synchronized (LOCK) { faults++; }
        emit("fault", "\"where\":\"" + where + "\"");
    }

    // ---- reflection over obfuscated 1.21.4 members (see Hooks for the mapping source) ----

    private static final java.util.concurrent.ConcurrentHashMap<String, Object> MEMBERS = new java.util.concurrent.ConcurrentHashMap<>();
    private static Method method(Object target, String name, Class<?>... params) throws ReflectiveOperationException {
        String key = target.getClass().getName() + "#" + name + java.util.Arrays.toString(params);
        Object cached = MEMBERS.get(key);
        if (cached instanceof Method m) return m;
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try { Method m = c.getDeclaredMethod(name, params); m.setAccessible(true); MEMBERS.put(key, m); return m; }
            catch (NoSuchMethodException ignored) { }
        }
        throw new NoSuchMethodException(key);
    }
    private static Field field(Object target, String owner, String name) throws ReflectiveOperationException {
        String key = owner + "." + name;
        Object cached = MEMBERS.get(key);
        if (cached instanceof Field f) return f;
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            if (!c.getName().equals(owner)) continue;
            Field f = c.getDeclaredField(name); f.setAccessible(true); MEMBERS.put(key, f); return f;
        }
        throw new NoSuchFieldException(key);
    }
    private static Object call(Object target, String name) throws ReflectiveOperationException { return method(target, name).invoke(target); }
    private static int entityId(Object entity) throws ReflectiveOperationException { return (Integer) call(entity, "ar"); }
    /** ServerGamePacketListenerImpl.player */
    private static Object listenerPlayer(Object listener) throws ReflectiveOperationException { return field(listener, "asg", "f").get(listener); }
    private static String profileName(Object player) throws ReflectiveOperationException {
        Object profile = call(player, "gh");
        return (String) profile.getClass().getMethod("getName").invoke(profile);
    }
    /** ServerPlayer.connection (ServerGamePacketListenerImpl) -> ServerCommonPacketListenerImpl.connection (Connection). */
    private static Object playerConnection(Object player) throws ReflectiveOperationException {
        Object listener = field(player, "are", "f").get(player);
        return listener == null ? null : field(listener, "asd", "e").get(listener);
    }
    private static String handName(Object hand) { return hand instanceof Enum<?> e ? (e.ordinal() == 0 ? "main" : e.ordinal() == 1 ? "off" : "unknown") : "unknown"; }

    // ---- hook entry points: signatures must match ClassPatcher.Hook.recorderDescriptor() ----

    public static void tick(Object minecraftServer) {
        tick++;
        if (!armed) return;
        long started = System.nanoTime();
        CALLS.increment();
        server = minecraftServer;
        try {
            Object list = call(minecraftServer, "ag");
            Object player = method(list, "a", String.class).invoke(list, target);
            Object previous = bobPlayer;
            if (player != previous) {
                bobPlayer = player;
                bobConnection = player == null ? null : playerConnection(player);
                connections++;
                emit("lifecycle", "\"event\":\"entity_changed\",\"conn\":" + connections + ",\"entity\":" + (player == null ? "null" : entityId(player)));
            }
            if (player == null) emit("tick", "\"bob\":null");
            else emit("tick", "\"bob\":{\"conn\":" + connections + ",\"entity\":" + entityId(player)
                + ",\"removed\":" + call(player, "dQ")
                + ",\"x\":" + call(player, "dA") + ",\"y\":" + call(player, "dC") + ",\"z\":" + call(player, "dG")
                + ",\"yaw\":" + call(player, "dL") + ",\"pitch\":" + call(player, "dN") + "}");
        } catch (Throwable t) { fault("tick"); }
        NANOS.add(System.nanoTime() - started);
    }

    public static void login(Object connection, Object player) {
        if (!armed) return;
        try { if (target.equalsIgnoreCase(profileName(player))) emit("lifecycle", "\"event\":\"login\",\"entity\":" + entityId(player)); }
        catch (Throwable t) { fault("login"); }
    }
    public static void respawn(Object player) {
        if (armed && player != null && player == bobPlayer) emit("lifecycle", "\"event\":\"respawn\"");
    }
    public static void death(Object player) {
        if (armed && player != null && player == bobPlayer) emit("lifecycle", "\"event\":\"death\"");
    }
    public static void disconnect(Object listener) {
        if (!armed) return;
        try { if (listenerPlayer(listener) == bobPlayer && bobPlayer != null) emit("lifecycle", "\"event\":\"disconnect\""); }
        catch (Throwable t) { fault("disconnect"); }
    }

    /** Netty thread, before the listener dispatches: complete decoded inbound stream for Bob's connection. */
    public static void inbound(Object connection, Object packet) {
        if (!armed || connection != bobConnection || connection == null) return;
        long started = System.nanoTime();
        CALLS.increment();
        try {
            String kind = Hooks.SERVERBOUND.getOrDefault(packet.getClass().getName(), "unknown");
            StringBuilder fields = new StringBuilder("\"kind\":\"").append(kind).append('"');
            if (kind.startsWith("ServerboundMovePlayerPacket")) {
                boolean hasRot = field(packet, "ahf", "i").getBoolean(packet), hasPos = field(packet, "ahf", "h").getBoolean(packet);
                fields.append(",\"hasPos\":").append(hasPos).append(",\"hasRot\":").append(hasRot);
                if (hasRot) fields.append(",\"yaw\":").append(field(packet, "ahf", "d").getFloat(packet)).append(",\"pitch\":").append(field(packet, "ahf", "e").getFloat(packet));
            } else if (kind.equals("ServerboundChatPacket")) {
                fields.append(",\"fixedHello\":").append(HELLO.equals(call(packet, "b")));
            } else if (kind.equals("ServerboundSwingPacket")) {
                fields.append(",\"hand\":\"").append(handName(call(packet, "b"))).append('"');
            }
            emit("packet", fields.toString());
        } catch (Throwable t) { fault("inbound"); }
        NANOS.add(System.nanoTime() - started);
    }

    public static void chat(Object message, Object sender) {
        if (!armed || sender == null || sender != bobPlayer) return;
        try { emit("effect", "\"effect\":\"chat\",\"fixedHello\":" + HELLO.equals(call(message, "c"))); }
        catch (Throwable t) { fault("chat"); }
    }
    /** Called even when the server suppresses a swing already in progress; the broadcast is the applied effect. */
    public static void swing(Object entity, Object hand) {
        if (armed && entity != null && entity == bobPlayer) emit("effect", "\"effect\":\"swing_call\",\"hand\":\"" + handName(hand) + "\"");
    }
    public static void broadcast(Object cache, Object entity, Object packet) { broadcast(cache, entity, packet, false); }
    public static void broadcastSelf(Object cache, Object entity, Object packet) { broadcast(cache, entity, packet, true); }
    private static void broadcast(Object cache, Object entity, Object packet, boolean self) {
        if (!armed || entity == null || entity != bobPlayer || packet == null || !"abo".equals(packet.getClass().getName())) return;
        try {
            int recipients = -1;
            try {
                Object chunkMap = field(cache, "ara", "a").get(cache);
                Object tracked = ((java.util.Map<?, ?>) field(chunkMap, "aqi", "K").get(chunkMap)).get(entityId(entity));
                if (tracked != null) recipients = ((java.util.Set<?>) field(tracked, "aqi$b", "f").get(tracked)).size();
            } catch (Throwable ignored) { }
            emit("effect", "\"effect\":\"animate_broadcast\",\"action\":" + call(packet, "e") + ",\"self\":" + self + ",\"recipients\":" + recipients);
        } catch (Throwable t) { fault("broadcast"); }
    }
    public static void attack(Object player, Object target) { bobEffect(player, "attack"); }
    public static void interact(Object player, Object target) { bobEffect(player, "interact"); }
    public static void useItem(Object player) { bobEffect(player, "use_item"); }
    public static void useItemOn(Object player) { bobEffect(player, "use_item_on"); }
    public static void drop(Object player) { bobEffect(player, "drop"); }
    public static void openMenu(Object player) { bobEffect(player, "open_menu"); }
    public static void forceRotation(Object player) { bobEffect(player, "force_rotation"); }
    public static void blockAction(Object gameMode) { gameModeEffect(gameMode, "block_action"); }
    public static void destroyBlock(Object gameMode) { gameModeEffect(gameMode, "destroy_block"); }
    public static void teleport(Object listener) {
        if (!armed) return;
        try { if (bobPlayer != null && listenerPlayer(listener) == bobPlayer) emit("effect", "\"effect\":\"correction\""); }
        catch (Throwable t) { fault("teleport"); }
    }
    public static void hurt(Object victim, Object source) {
        if (!armed || bobPlayer == null) return;
        try {
            if (victim == bobPlayer) emit("effect", "\"effect\":\"damage_taken\"");
            else if (source != null && call(source, "d") == bobPlayer) emit("effect", "\"effect\":\"damage_dealt\"");
        } catch (Throwable t) { fault("hurt"); }
    }
    private static void bobEffect(Object player, String effect) {
        if (armed && player != null && player == bobPlayer) emit("effect", "\"effect\":\"" + effect + "\"");
    }
    private static void gameModeEffect(Object gameMode, String effect) {
        if (!armed || bobPlayer == null) return;
        try { if (field(gameMode, "arf", "d").get(gameMode) == bobPlayer) emit("effect", "\"effect\":\"" + effect + "\""); }
        catch (Throwable t) { fault(effect); }
    }
}
