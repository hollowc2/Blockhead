package blockhead.observer;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Inserts a static call at the entry of selected methods, and nothing else.
 *
 * The prefix loads the requested reference locals, invokes a static recorder
 * method with a void return, and is padded with NOPs to a multiple of four bytes
 * so tableswitch/lookupswitch alignment is unchanged. Relative branch offsets are
 * unaffected by a prefix; absolute offsets (exception table, StackMapTable first
 * delta and uninitialized(offset) types, line/local-variable tables) are shifted.
 * A method with any other Code attribute, or that is a constructor/abstract/native,
 * is left untouched and reported as not patched.
 *
 * No dependency beyond java.base, so it builds with any JDK 21+ and runs on the
 * server's Java 25 runtime.
 */
public final class ClassPatcher {
    /** One entry hook: target method and the static recorder method that receives the listed reference locals. */
    public record Hook(String id, String owner, String name, String descriptor, int[] slots, String recorderOwner, String recorderName) {
        String recorderDescriptor() { return "(" + "Ljava/lang/Object;".repeat(slots.length) + ")V"; }
    }

    public record Result(byte[] bytes, Set<String> patched) {}

    private static final Set<String> SHIFTABLE = Set.of("StackMapTable", "LineNumberTable", "LocalVariableTable", "LocalVariableTypeTable");

    private ClassPatcher() {}

    /** Patches every hook in *hooks* (all with the same owner) that matches a method; returns null bytes when none did. */
    public static Result patch(byte[] original, List<Hook> hooks) throws IOException {
        Reader in = new Reader(original);
        if (in.u4() != 0xCAFEBABEL) throw new IOException("not a class file");
        int minor = in.u2(), major = in.u2();
        if (major < 50) throw new IOException("class file without stack maps");
        int cpCount = in.u2();
        String[] utf8 = new String[cpCount];
        int cpStart = in.pos;
        for (int i = 1; i < cpCount; i++) {
            int tag = in.u1();
            switch (tag) {
                case 1 -> utf8[i] = in.utf();
                case 3, 4 -> in.skip(4);
                case 5, 6 -> { in.skip(8); i++; }
                case 7, 8, 16, 19, 20 -> in.skip(2);
                case 9, 10, 11, 12, 17, 18 -> in.skip(4);
                case 15 -> in.skip(3);
                default -> throw new IOException("unknown constant pool tag " + tag);
            }
        }
        byte[] pool = java.util.Arrays.copyOfRange(original, cpStart, in.pos);
        Pool extra = new Pool(cpCount);
        int accessThisSuper = in.pos;
        in.skip(6);
        int interfaces = in.u2();
        in.skip(2 * interfaces);
        int fields = in.u2();
        for (int f = 0; f < fields; f++) { in.skip(6); skipAttributes(in); }
        byte[] headerAndFields = java.util.Arrays.copyOfRange(original, accessThisSuper, in.pos);

        ByteArrayOutputStream methodsOut = new ByteArrayOutputStream();
        DataOutputStream mo = new DataOutputStream(methodsOut);
        int methods = in.u2();
        mo.writeShort(methods);
        Set<String> patched = new java.util.LinkedHashSet<>();
        for (int m = 0; m < methods; m++) {
            int access = in.u2(), nameIndex = in.u2(), descIndex = in.u2();
            String name = utf8[nameIndex], desc = utf8[descIndex];
            Hook hook = null;
            for (Hook h : hooks) if (h.name().equals(name) && h.descriptor().equals(desc)) hook = h;
            boolean eligible = hook != null && (access & 0x0400) == 0 && (access & 0x0100) == 0 && !name.startsWith("<");
            mo.writeShort(access); mo.writeShort(nameIndex); mo.writeShort(descIndex);
            int attributes = in.u2();
            mo.writeShort(attributes);
            for (int a = 0; a < attributes; a++) {
                int attrName = in.u2();
                int length = (int) in.u4();
                byte[] body = in.bytes(length);
                if (eligible && "Code".equals(utf8[attrName])) {
                    byte[] rewritten = rewriteCode(body, hook, utf8, extra, (access & 0x0008) != 0);
                    if (rewritten != null) { body = rewritten; patched.add(hook.id()); }
                }
                mo.writeShort(attrName); mo.writeInt(body.length); mo.write(body);
            }
        }
        byte[] rest = java.util.Arrays.copyOfRange(original, in.pos, original.length);
        if (patched.isEmpty()) return new Result(null, patched);
        if (extra.next > 65535) throw new IOException("constant pool overflow");

        ByteArrayOutputStream out = new ByteArrayOutputStream(original.length + 256);
        DataOutputStream o = new DataOutputStream(out);
        o.writeInt(0xCAFEBABE); o.writeShort(minor); o.writeShort(major);
        o.writeShort(extra.next);
        o.write(pool);
        o.write(extra.bytes());
        o.write(headerAndFields);
        o.write(methodsOut.toByteArray());
        o.write(rest);
        return new Result(out.toByteArray(), patched);
    }

    private static void skipAttributes(Reader in) {
        int count = in.u2();
        for (int a = 0; a < count; a++) { in.skip(2); in.skip((int) in.u4()); }
    }

    /** Local slots occupied by the receiver and each parameter, in order. */
    public static int[] parameterSlots(String descriptor, boolean isStatic) {
        List<Integer> slots = new ArrayList<>();
        int slot = 0;
        if (!isStatic) slots.add(slot++);
        int i = 1;
        while (descriptor.charAt(i) != ')') {
            slots.add(slot);
            int start = i;
            while (descriptor.charAt(i) == '[') i++;
            if (descriptor.charAt(i) == 'L') i = descriptor.indexOf(';', i);
            slot += (descriptor.charAt(start) == 'J' || descriptor.charAt(start) == 'D') ? 2 : 1;
            i++;
        }
        return slots.stream().mapToInt(Integer::intValue).toArray();
    }

    private static boolean isReferenceAt(String descriptor, boolean isStatic, int slot) {
        if (!isStatic && slot == 0) return true;
        int current = isStatic ? 0 : 1;
        int i = 1;
        while (descriptor.charAt(i) != ')') {
            char c = descriptor.charAt(i);
            boolean reference = c == 'L' || c == '[';
            int start = i;
            while (descriptor.charAt(i) == '[') i++;
            if (descriptor.charAt(i) == 'L') i = descriptor.indexOf(';', i);
            i++;
            if (current == slot) return reference;
            current += (descriptor.charAt(start) == 'J' || descriptor.charAt(start) == 'D') ? 2 : 1;
        }
        return false;
    }

    private static byte[] rewriteCode(byte[] code, Hook hook, String[] utf8, Pool extra, boolean isStatic) throws IOException {
        for (int slot : hook.slots()) if (!isReferenceAt(hook.descriptor(), isStatic, slot)) return null;
        Reader in = new Reader(code);
        int maxStack = in.u2(), maxLocals = in.u2();
        int codeLength = (int) in.u4();
        byte[] body = in.bytes(codeLength);
        int handlers = in.u2();
        int[][] table = new int[handlers][4];
        for (int h = 0; h < handlers; h++) for (int k = 0; k < 4; k++) table[h][k] = in.u2();
        int attributes = in.u2();
        List<Object[]> attrs = new ArrayList<>();
        for (int a = 0; a < attributes; a++) {
            int nameIndex = in.u2();
            byte[] data = in.bytes((int) in.u4());
            if (!SHIFTABLE.contains(utf8[nameIndex])) return null;
            attrs.add(new Object[]{nameIndex, data});
        }

        ByteArrayOutputStream prefix = new ByteArrayOutputStream();
        for (int slot : hook.slots()) {
            if (slot <= 3) prefix.write(0x2a + slot);
            else if (slot <= 255) { prefix.write(0x19); prefix.write(slot); }
            else return null;
        }
        int method = extra.methodref(hook.recorderOwner(), hook.recorderName(), hook.recorderDescriptor());
        prefix.write(0xb8); prefix.write(method >> 8); prefix.write(method & 0xff);
        while (prefix.size() % 4 != 0) prefix.write(0x00);
        int shift = prefix.size();
        if (codeLength + shift > 65535) return null;

        ByteArrayOutputStream out = new ByteArrayOutputStream(code.length + shift + 32);
        DataOutputStream o = new DataOutputStream(out);
        o.writeShort(Math.max(maxStack, hook.slots().length));
        o.writeShort(maxLocals);
        o.writeInt(codeLength + shift);
        o.write(prefix.toByteArray());
        o.write(body);
        o.writeShort(handlers);
        for (int[] row : table) { o.writeShort(row[0] + shift); o.writeShort(row[1] + shift); o.writeShort(row[2] + shift); o.writeShort(row[3]); }
        o.writeShort(attrs.size());
        for (Object[] attr : attrs) {
            int nameIndex = (int) attr[0];
            byte[] data = (byte[]) attr[1];
            byte[] shifted = switch (utf8[nameIndex]) {
                case "StackMapTable" -> shiftStackMap(data, shift);
                case "LineNumberTable" -> shiftLineNumbers(data, shift);
                default -> shiftLocals(data, shift);
            };
            o.writeShort(nameIndex); o.writeInt(shifted.length); o.write(shifted);
        }
        return out.toByteArray();
    }

    private static byte[] shiftLineNumbers(byte[] data, int shift) {
        ByteBuffer b = ByteBuffer.wrap(data.clone());
        int count = b.getShort() & 0xffff;
        for (int i = 0; i < count; i++) { int at = b.position(); b.putShort(at, (short) ((b.getShort(at) & 0xffff) + shift)); b.position(at + 4); }
        return b.array();
    }

    /** start_pc 0 keeps covering the method from the new first instruction; later ranges move. */
    private static byte[] shiftLocals(byte[] data, int shift) {
        ByteBuffer b = ByteBuffer.wrap(data.clone());
        int count = b.getShort() & 0xffff;
        for (int i = 0; i < count; i++) {
            int at = b.position();
            int start = b.getShort(at) & 0xffff, length = b.getShort(at + 2) & 0xffff;
            if (start == 0) b.putShort(at + 2, (short) (length + shift));
            else b.putShort(at, (short) (start + shift));
            b.position(at + 10);
        }
        return b.array();
    }

    private static byte[] shiftStackMap(byte[] data, int shift) throws IOException {
        Reader in = new Reader(data);
        ByteArrayOutputStream out = new ByteArrayOutputStream(data.length + 4);
        DataOutputStream o = new DataOutputStream(out);
        int count = in.u2();
        o.writeShort(count);
        for (int f = 0; f < count; f++) {
            int type = in.u1();
            int add = f == 0 ? shift : 0;
            if (type <= 63) {
                int delta = type + add;
                if (delta <= 63) o.writeByte(delta); else { o.writeByte(251); o.writeShort(delta); }
            } else if (type <= 127) {
                int delta = type - 64 + add;
                if (delta <= 63) o.writeByte(64 + delta); else { o.writeByte(247); o.writeShort(delta); }
                copyType(in, o, shift);
            } else if (type == 247) {
                o.writeByte(type); o.writeShort(in.u2() + add); copyType(in, o, shift);
            } else if (type >= 248 && type <= 251) {
                o.writeByte(type); o.writeShort(in.u2() + add);
            } else if (type >= 252 && type <= 254) {
                o.writeByte(type); o.writeShort(in.u2() + add);
                for (int k = 0; k < type - 251; k++) copyType(in, o, shift);
            } else if (type == 255) {
                o.writeByte(type); o.writeShort(in.u2() + add);
                int locals = in.u2(); o.writeShort(locals);
                for (int k = 0; k < locals; k++) copyType(in, o, shift);
                int stack = in.u2(); o.writeShort(stack);
                for (int k = 0; k < stack; k++) copyType(in, o, shift);
            } else throw new IOException("reserved stack map frame type " + type);
        }
        if (in.pos != data.length) throw new IOException("trailing stack map bytes");
        return out.toByteArray();
    }

    private static void copyType(Reader in, DataOutputStream o, int shift) throws IOException {
        int tag = in.u1();
        o.writeByte(tag);
        if (tag == 7) o.writeShort(in.u2());
        else if (tag == 8) o.writeShort(in.u2() + shift);
        else if (tag > 8) throw new IOException("unknown verification type " + tag);
    }

    /** Appended constant pool entries, deduplicated. */
    private static final class Pool {
        int next;
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();
        private final Map<String, Integer> seen = new java.util.HashMap<>();
        Pool(int next) { this.next = next; }
        int utf8(String s) {
            return seen.computeIfAbsent("U" + s, k -> {
                byte[] bytes = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                out.write(1); out.write(bytes.length >> 8); out.write(bytes.length & 0xff); out.write(bytes, 0, bytes.length);
                return next++;
            });
        }
        int classRef(String internal) {
            int name = utf8(internal);
            return seen.computeIfAbsent("C" + internal, k -> { out.write(7); out.write(name >> 8); out.write(name & 0xff); return next++; });
        }
        int methodref(String owner, String name, String desc) {
            int c = classRef(owner), n = utf8(name), d = utf8(desc);
            int nat = seen.computeIfAbsent("N" + name + desc, k -> { out.write(12); out.write(n >> 8); out.write(n & 0xff); out.write(d >> 8); out.write(d & 0xff); return next++; });
            return seen.computeIfAbsent("M" + owner + "." + name + desc, k -> { out.write(10); out.write(c >> 8); out.write(c & 0xff); out.write(nat >> 8); out.write(nat & 0xff); return next++; });
        }
        byte[] bytes() { return out.toByteArray(); }
    }

    private static final class Reader {
        final byte[] b; int pos;
        Reader(byte[] b) { this.b = b; }
        int u1() { return b[pos++] & 0xff; }
        int u2() { int v = ((b[pos] & 0xff) << 8) | (b[pos + 1] & 0xff); pos += 2; return v; }
        long u4() { long v = ((long) (b[pos] & 0xff) << 24) | ((b[pos + 1] & 0xff) << 16) | ((b[pos + 2] & 0xff) << 8) | (b[pos + 3] & 0xff); pos += 4; return v; }
        void skip(int n) { pos += n; }
        byte[] bytes(int n) { byte[] r = java.util.Arrays.copyOfRange(b, pos, pos + n); pos += n; return r; }
        String utf() {
            int length = u2();
            try {
                String s = new java.io.DataInputStream(new java.io.ByteArrayInputStream(b, pos - 2, length + 2)).readUTF();
                pos += length;
                return s;
            } catch (IOException e) { throw new java.io.UncheckedIOException(e); }
        }
    }
}
