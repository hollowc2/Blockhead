# Independent effect observation preparation

Status: design only; no independent observer is ready. No instrumentation,
packet interception, JVM attachment, extra player, console command or game
connection was installed or used. The four-file candidate remains diagnostic.

The version-specific capability and enderman reviews remain authoritative for
this plan. Positive client metadata may warn; false/missing flags never prove
calm. Persistent anger target/time and complete pending-target state remain
unavailable to this client. Retain the conservative all-endermen refusal.

## Required evidence before enabling actions

An independent server observation must identify the current server run, Bob's
connection/lifecycle, entity and monotonic tick sequence. Capture must already
be running and healthy before admission, with a baseline immediately before
each once-only request. Match a single request to a bounded interval without
adding identifiers to Minecraft chat or changing the four effects. Any other
operation in the interval, reconnect, respawn, capture gap, truncation, missing
baseline or ambiguous correlation makes the result **unknown**, not passed.

Use two distinct observation points: complete decoded inbound packet handling
at the server connection, and server-side applied effects/broadcasts. Packet
receipt alone does not prove game-effect acceptance. A client-side write hook
alone would not be independent. Existing ordinary server logs do not provide
the required packet/effect stream; their availability is not readiness.

- Hello: exactly one accepted fixed chat message from Bob; correlate the
  independent server record with any incoming self echo. A lifecycle total
  cannot establish once-only delivery for a particular HTTP request.
- Wave: exactly one main-hand swing processed by the server and one normal
  tracked-player broadcast, with no off-hand swing. The normal self echo is
  excluded, so a zero incoming self-animation count is inconclusive.
- Turns: capture server position, pitch and yaw before/after application.
  Verify the signed 45-degree yaw change modulo a full turn, unchanged pitch
  and position, and no additional turn. Specify protocol quantization tolerance
  from the installed serializer before testing; do not choose it after seeing
  results. A position correction or viewer pose is not this acknowledgement.
- For every gesture, complete coverage must show no attack/entity interaction,
  use-item, use-on-block or other prohibited mutation during the correlated
  interval. Missing packets or an unrecognized packet type prevent an absence
  claim. Also observe actual damage/use effects independently. Natural owner
  or survival work preempts the trial; preserve it and mark ambiguous overlap
  unknown instead of suppressing it.

Keep capture bounded and private: fixed counters and typed effect records,
limited duration/size, no arbitrary chat, UUID history or raw packet dump in
public state. Overflow must mark coverage incomplete. Health/lifecycle
timestamps and dropped-record counts are part of the evidence.

## Local qualification for a future separate candidate

Before requesting any new live instrumentation approval, build and test a
separate collector against the installed 1.21.4 signatures/protocol. Exercise
missing/duplicate/reordered records, lifecycle changes, tick discontinuity,
buffer overflow, unsupported schemas, yaw wrap and quantization, arm selection,
attack/use violations and natural-work overlap. Prove collection sends no game
packets or world mutations, and teardown removes every hook. Test synthetic
traces where HTTP succeeds but the effect is missing: they must remain unknown.

This is a preparation contract, not a tested collector or an additional install
manifest. Choosing a server hook requires a separate exact delta, overhead and
rollback review, local tests and explicit approval. Do not attach to the running
JVM, install tools or start another player to complete this design. The current
four-file deployment approval request does not include any of those actions.

After an independently qualified observer is approved and ready, require every
authoritative safety gate to pass in the same live session under the immediate
lease before the planned public HTTPS trial. Respect production cooldowns;
never retry uncertain delivery. Leave actions disabled afterward. Enabled busy,
concurrent, disable and owner/survival acceptance also remain unverified; owner
boundary checks continue to use read-only inspection only.
