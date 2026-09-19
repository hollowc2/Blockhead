# Creative material provisioning

Creative architectural builds use `provideCreativeItem()` in
`src/minecraft/mode.ts`. It only provisions approved building materials, uses
empty main-inventory/hotbar slots, serializes requests per bot, and returns an
item after the server inventory update has been observed. Minecraft protocol
770 (1.21.5) uses the project-owned `UntrustedSlot` compatibility adapter;
older versions continue through Mineflayer's creative API.

The optional live smoke test connects using the normal configured bot account,
confirms creative mode, obtains one stone-brick block, and equips it. It does
not place a block or modify the world:

```bash
BLOCKHEAD_CONFIG=config/minecraft.yaml npm run creative:smoke
```

Run only against a disposable/test server. The command requires the configured
Minecraft server and bot credentials to be available and does not run as part
of `npm test`.
