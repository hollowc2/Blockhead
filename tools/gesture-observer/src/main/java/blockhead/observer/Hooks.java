package blockhead.observer;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Entry hooks for vanilla Minecraft 1.21.4 (protocol 769), obfuscated names from
 * the official server mappings (server.txt SHA-1 0b1e60cc509cfb0172573ae56b436c29febbc187)
 * for the server JAR whose nested server-1.21.4.jar has SHA-256
 * de9538d2497c8f4174805f3fcedb8ade3060446aa203f351b820ea5bd04adbf4.
 * The Mojang name of each target is in its comment. The agent refuses to patch
 * anything unless version.json reports exactly this version and protocol.
 */
public final class Hooks {
    public static final String MC_VERSION = "1.21.4";
    public static final int MC_PROTOCOL = 769;
    static final String RECORDER = "blockhead/observer/Recorder";

    private static ClassPatcher.Hook hook(String id, String owner, String name, String desc, int[] slots, String recorder) {
        return new ClassPatcher.Hook(id, owner, name, desc, slots, RECORDER, recorder);
    }

    public static final List<ClassPatcher.Hook> ALL = List.of(
        // MinecraftServer.tickServer(BooleanSupplier): tick counter and Bob's authoritative pose.
        hook("tick", "net/minecraft/server/MinecraftServer", "a", "(Ljava/util/function/BooleanSupplier;)V", new int[]{0}, "tick"),
        // PlayerList.placeNewPlayer(Connection, ServerPlayer, CommonListenerCookie)
        hook("login", "avd", "a", "(Lvi;Lare;Lart;)V", new int[]{1, 2}, "login"),
        // PlayerList.respawn(ServerPlayer, boolean, Entity.RemovalReason)
        hook("respawn", "avd", "a", "(Lare;ZLbum$d;)Lare;", new int[]{1}, "respawn"),
        // ServerGamePacketListenerImpl.onDisconnect(DisconnectionDetails)
        hook("disconnect", "asg", "a", "(Lvk;)V", new int[]{0}, "disconnect"),
        // ServerPlayer.die(DamageSource)
        hook("death", "are", "a", "(Lbtc;)V", new int[]{0}, "death"),
        // Connection.channelRead0(ChannelHandlerContext, Packet): every decoded inbound packet.
        hook("inbound", "vi", "a", "(Lio/netty/channel/ChannelHandlerContext;Lyw;)V", new int[]{0, 2}, "inbound"),
        // PlayerList.broadcastChatMessage(PlayerChatMessage, Predicate, ServerPlayer, ChatType.Bound)
        hook("chat", "avd", "a", "(Lxf;Ljava/util/function/Predicate;Lare;Lwl$a;)V", new int[]{1, 3}, "chat"),
        // LivingEntity.swing(InteractionHand, boolean)
        hook("swing", "bvi", "a", "(Lbsk;Z)V", new int[]{0, 1}, "swing"),
        // ServerChunkCache.broadcast(Entity, Packet): tracked players except the entity itself.
        hook("broadcast", "ara", "b", "(Lbum;Lyw;)V", new int[]{0, 1, 2}, "broadcast"),
        // ServerChunkCache.broadcastAndSend(Entity, Packet): tracked players and the entity.
        hook("broadcast_self", "ara", "a", "(Lbum;Lyw;)V", new int[]{0, 1, 2}, "broadcastSelf"),
        // Player.attack(Entity)
        hook("attack", "coy", "e", "(Lbum;)V", new int[]{0, 1}, "attack"),
        // Player.interactOn(Entity, InteractionHand)
        hook("interact", "coy", "a", "(Lbum;Lbsk;)Lbsl;", new int[]{0, 1}, "interact"),
        // ServerPlayerGameMode.useItem(ServerPlayer, Level, ItemStack, InteractionHand)
        hook("use_item", "arf", "a", "(Lare;Ldgj;Lcwq;Lbsk;)Lbsl;", new int[]{1}, "useItem"),
        // ServerPlayerGameMode.useItemOn(ServerPlayer, Level, ItemStack, InteractionHand, BlockHitResult)
        hook("use_item_on", "arf", "a", "(Lare;Ldgj;Lcwq;Lbsk;Lfax;)Lbsl;", new int[]{1}, "useItemOn"),
        // ServerPlayerGameMode.handleBlockBreakAction(BlockPos, Action, Direction, int, int)
        hook("block_action", "arf", "a", "(Lji;Lahm$a;Ljn;II)V", new int[]{0}, "blockAction"),
        // ServerPlayerGameMode.destroyBlock(BlockPos)
        hook("destroy_block", "arf", "a", "(Lji;)Z", new int[]{0}, "destroyBlock"),
        // ServerPlayer.drop(boolean)
        hook("drop_selected", "are", "a", "(Z)Z", new int[]{0}, "drop"),
        // ServerPlayer.drop(ItemStack, boolean, boolean)
        hook("drop_stack", "are", "a", "(Lcwq;ZZ)Lcld;", new int[]{0}, "drop"),
        // ServerPlayer.openMenu(MenuProvider)
        hook("open_menu", "are", "a", "(Lbsn;)Ljava/util/OptionalInt;", new int[]{0}, "openMenu"),
        // LivingEntity.hurtServer(ServerLevel, DamageSource, float)
        hook("hurt", "bvi", "a", "(Lard;Lbtc;F)Z", new int[]{0, 2}, "hurt"),
        // ServerGamePacketListenerImpl.teleport(PositionMoveRotation, Set)
        hook("teleport", "asg", "a", "(Lbvv;Ljava/util/Set;)V", new int[]{0}, "teleport"),
        // ServerPlayer.forceSetRotation(float, float)
        hook("force_rotation", "are", "a", "(FF)V", new int[]{0}, "forceRotation")
    );

    public static Map<String, List<ClassPatcher.Hook>> byOwner() {
        Map<String, List<ClassPatcher.Hook>> map = new HashMap<>();
        for (ClassPatcher.Hook h : ALL) map.computeIfAbsent(h.owner(), k -> new java.util.ArrayList<>()).add(h);
        return map;
    }

    /** Every serverbound packet class in 1.21.4 (obfuscated -> Mojang simple name). Anything else is "unknown". */
    public static final Map<String, String> SERVERBOUND = table("""
        zq ServerboundClientInformationPacket; zr ServerboundCustomPayloadPacket; zs ServerboundKeepAlivePacket; zt ServerboundPongPacket;
        zu ServerboundResourcePackPacket; abc ServerboundFinishConfigurationPacket; abj ServerboundCookieResponsePacket;
        agi ServerboundAcceptTeleportationPacket; agj ServerboundBlockEntityTagQueryPacket; agk ServerboundChangeDifficultyPacket;
        agl ServerboundChatAckPacket; agm ServerboundChatCommandPacket; agn ServerboundChatCommandSignedPacket; ago ServerboundChatPacket;
        agp ServerboundChatSessionUpdatePacket; agq ServerboundChunkBatchReceivedPacket; agr ServerboundClientCommandPacket;
        ags ServerboundClientTickEndPacket; agt ServerboundCommandSuggestionPacket; agu ServerboundConfigurationAcknowledgedPacket;
        agv ServerboundContainerButtonClickPacket; agw ServerboundContainerClickPacket; agx ServerboundContainerClosePacket;
        agy ServerboundContainerSlotStateChangedPacket; agz ServerboundDebugSampleSubscriptionPacket; aha ServerboundEditBookPacket;
        ahb ServerboundEntityTagQueryPacket; ahc ServerboundInteractPacket; ahd ServerboundJigsawGeneratePacket;
        ahe ServerboundLockDifficultyPacket; ahf$a ServerboundMovePlayerPacket$Pos; ahf$b ServerboundMovePlayerPacket$PosRot;
        ahf$c ServerboundMovePlayerPacket$Rot; ahf$d ServerboundMovePlayerPacket$StatusOnly; ahg ServerboundMoveVehiclePacket;
        ahh ServerboundPaddleBoatPacket; ahi ServerboundPickItemFromBlockPacket; ahj ServerboundPickItemFromEntityPacket;
        ahk ServerboundPlaceRecipePacket; ahl ServerboundPlayerAbilitiesPacket; ahm ServerboundPlayerActionPacket;
        ahn ServerboundPlayerCommandPacket; aho ServerboundPlayerInputPacket; ahp ServerboundPlayerLoadedPacket;
        ahq ServerboundRecipeBookChangeSettingsPacket; ahr ServerboundRecipeBookSeenRecipePacket; ahs ServerboundRenameItemPacket;
        aht ServerboundSeenAdvancementsPacket; ahu ServerboundSelectBundleItemPacket; ahv ServerboundSelectTradePacket;
        ahw ServerboundSetBeaconPacket; ahx ServerboundSetCarriedItemPacket; ahy ServerboundSetCommandBlockPacket;
        ahz ServerboundSetCommandMinecartPacket; aia ServerboundSetCreativeModeSlotPacket; aib ServerboundSetJigsawBlockPacket;
        aic ServerboundSetStructureBlockPacket; aid ServerboundSignUpdatePacket; aie ServerboundSwingPacket;
        aif ServerboundTeleportToEntityPacket; aig ServerboundUseItemOnPacket; aih ServerboundUseItemPacket;
        aiz ServerboundCustomQueryAnswerPacket; aja ServerboundHelloPacket; ajb ServerboundKeyPacket;
        ajc ServerboundLoginAcknowledgedPacket; ajo ServerboundPingRequestPacket; aju ServerboundStatusRequestPacket""");

    private static Map<String, String> table(String text) {
        Map<String, String> map = new HashMap<>();
        for (String entry : text.split(";")) {
            String[] parts = entry.trim().split("\\s+");
            map.put(parts[0], parts[1]);
        }
        return Map.copyOf(map);
    }

    private Hooks() {}
}
