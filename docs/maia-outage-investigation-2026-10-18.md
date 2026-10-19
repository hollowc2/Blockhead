# Maia outage investigation — 2026-10-18

Read-only investigation around 12:17–12:25 PDT, `corey@maia` (alias resolves
`maia.local`). No service or host settings were changed. No stress tests,
second bot, console commands, package installs, or world writes were run.

## Observed evidence

- Current boot began October 18 at 12:08 PDT, kernel `7.2.0-1-cachyos`.
  The only retained prior boot spans October 15 21:11:28–23:21:55 PDT;
  this is the **available journal window**, not evidence that boot began then.
  No shutdown sequence explains the gap. `last -x` includes a crashed older
  session, but is not a freeze-cause detector.
- Targeted prior/current kernel searches found no recorded suspend entry,
  OOM kill, NVIDIA Xid, BUG/Oops, lockup, hung task, NFS error, disk I/O error,
  or hardware-error report in the retained window. Current thermal messages
  were governor registration. An abrupt kernel/hardware failure can prevent
  recording; journal absence does not exclude any such cause.
- `/etc/systemd/sleep.conf.d/90-maia-no-suspend.conf` already disables suspend,
  hibernation, hybrid sleep and suspend-then-hibernate. Its mtime is October 11.
  Logind has no active IdleAction override (default ignore); no running user
  power/idle service appeared in the inspected units. `/sys/power/mem_sleep`
  shows `s2idle [deep]`; ACPI lists several enabled wake devices. Those entries
  describe capabilities, not an observed sleep/wake event. No new power-policy
  change is justified by this evidence.
- Prior journal ends with cvtrack startup failure, restart counter **61,528**.
  Last attempts consumed about 5.5 CPU seconds per 6.3 wall seconds and peaked
  around 386–419 MB. Current boot records C920 video-source open failure too.
  System `cvtrack.service` is now **inactive and disabled**, confirmed twice;
  user service lookup alone is insufficient. It was left unchanged. This is
  evidence of sustained resource waste, **not proof it froze Maia**.
- Main user services were active, each with `NRestarts=0` and start time 12:08:10.
  Bot status at 12:18 showed connected, health/hunger 20/20, 23 consecutive
  development failures, and the owner room blocked. This distinguishes bot
  work failures from current host reachability.
- Snapshot: 15 GiB RAM, about 10 GiB available, 2.1 MiB swap used; root disk
  57% used / 201 GiB free. GPU 47°C, 6578/8192 MiB allocated, 0% utilization;
  CPU sensor later 32.2°C. Memory PSI averages were zero; I/O PSI existed
  (about 0.30% full over 60 seconds in one sample). These post-reboot values
  cannot reconstruct pre-freeze pressure.
- `/mnt/Repos` and `/mnt/Models` are Eros NFSv4.2 **hard** mounts, TCP,
  `timeo=600,retrans=2`. Bot runtime code/dependencies are local; its working
  directory, SQLite/logs/config and LLM model remain NFS dependent. NFS stalls
  are therefore plausible application stalls; no retained error proves one.
- Persistent `/var/log/journal` exists, with 42.4 MB currently retained.
  Vendor journald drop-in sets `SystemMaxUse=50M`; default sync is five minutes.
  The small cap and restart noise reduce historical evidence.
- `maia-metrics.timer` runs every 15 seconds and last run succeeded.
  `/usr/local/bin/maia-metrics.sh` atomically writes GPU metrics to
  `/var/lib/prometheus/node-exporter/maia.prom`. Node exporter is enabled and
  active. The script's three LLM throughput/queue values are hardcoded zero;
  they must not be interpreted as measurements. Remote scraping/retention and
  incident alerts were not verified from Maia alone.
- Runtime watchdog is off, NMI watchdog is 0, kernel command line includes
  `nowatchdog`, panic timeout is 0. No kdump service; systemd-pstore is disabled;
  `/var/crash` absent; no coredumps found. Reading pstore and SMART attributes
  requires root; bounded `sudo -n` probes failed because a password is required.
  Thus storage SMART health and retained firmware crash records are unknown.

## Prepared changes, not installed

1. [Read-only capture script](../scripts/maia-readonly-capture): independently
   time-limits every diagnostic, avoids environments and full command lines,
   captures both boots, pressure, service restart counts, sensors and bot status.
   `bash -n` passed; running it over SSH through `bash -s` succeeded without
   installing anything. Output was retained locally in
   `/tmp/cobblebob-20261018/capture-smoke.txt` during this investigation.
2. [Proposed journald drop-in](../deploy/maia-journald-observability.conf.proposed):
   persistent storage, 256 MB cap, keep 1 GB free, sync every 30 seconds.
   This addresses a demonstrated evidence-retention limit; it does not fix
   the unknown freeze. Increased write frequency is a tradeoff.

After **separate explicit host-change approval**, the exact proposal is:

```bash
# On Maia; refuse to overwrite a preexisting proposal target.
sudo test ! -e /etc/systemd/journald.conf.d/90-maia-evidence.conf
sudo install -d -m 0755 /etc/systemd/journald.conf.d
sudo install -m 0644 /mnt/Repos/Games/Blockhead/deploy/maia-journald-observability.conf.proposed /etc/systemd/journald.conf.d/90-maia-evidence.conf
sudo systemctl restart systemd-journald.service
systemd-analyze cat-config systemd/journald.conf
journalctl --disk-usage
```

Run commands sequentially, stop on failure. Rollback: after checking that the
target matches this proposal, remove that one new drop-in and restart journald
with approval. Do not remove or edit the existing vendor limit. No package,
network, power, watchdog, or cvtrack enable/start change is proposed now.
Watchdog/kdump needs a separate hardware/boot-support review before proposing
exact settings; blind enablement could produce reboot loops or lose evidence.

## Next occurrence

- While reachable, collect the prepared script to **observer-local storage**:
  `ssh -F /dev/null -o BatchMode=yes corey@maia.local 'bash -s' < scripts/maia-readonly-capture > /tmp/maia-incident.txt`.
  Save the wall-clock time and symptoms. This does not require installation.
- If SSH fails, independently record LAN/Tailscale reachability from another
  machine, Eros/NFS reachability, node-exporter scrape availability, and whether
  Minecraft/LLM ports still answer. Use bounded probes; avoid repeated bot starts.
- At the physical console, record display state, caps-lock/keyboard response,
  network link and power state before any hard reboot. Do not infer suspend
  solely from network silence. If console responds, collect blocked-task and
  kernel evidence before reboot; privileged diagnostic operations need approval.
- After recovery, immediately capture both boots before journal rollover.
  Request a narrow privileged read of `smartctl -H -A /dev/sda` and
  `/sys/fs/pstore`, then evaluate remote metrics surrounding the exact timestamp.
  Do not run disk self-tests or stress tests as part of capture.
- Verify that an independent monitoring system actually retains exporter
  pressure, memory, disk latency, temperature, availability and restart history.
  The existing exporter is an endpoint, not proof of historical storage.

The cause remains **unknown**. Hardware/kernel abrupt failure, storage/network
stalls and resource pressure remain hypotheses with different missing evidence.
