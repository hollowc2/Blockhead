package blockhead.observer;

/** Bytecode shapes the entry patcher must preserve: switches, handlers, loops at offset 0, uninitialized frames, wide locals. */
public class Fixture {
    private final String label;
    public Fixture(String label) { this.label = label; }

    public String table(Object tag, int n) {
        switch (n) { case 0: return "zero"; case 1: return "one"; case 2: return "two"; case 3: return "three"; default: return label + n; }
    }

    public String lookup(Object tag, int n) {
        switch (n) { case -1000: return "low"; case 7: return "seven"; case 100000: return "high"; default: return "other"; }
    }

    public int handler(Object tag, String value) {
        try { return Integer.parseInt(value); }
        catch (NumberFormatException e) { return -1; }
        finally { if (value == null) throw new IllegalStateException(); }
    }

    /** javac emits a backward branch whose target frame can sit near the method start. */
    public long loop(Object tag, long count, double scale) {
        long total = 0;
        while (count-- > 0) total += (long) scale;
        return total;
    }

    /** An uninitialized(new) type is live across the conditional branch. */
    public Fixture uninitialized(Object tag, boolean flag) {
        return new Fixture(flag ? "yes" : "no");
    }

    public static String statics(Object a, long wide, Object b) { return a + ":" + wide + ":" + b; }

    public int wideLocals(Object a, Object b, Object c, Object d, Object e) {
        int sum = 0;
        for (Object o : new Object[]{a, b, c, d, e}) if (o != null) sum += o.hashCode() % 7;
        return sum;
    }

    public String label() { return label; }
}
