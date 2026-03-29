import { FluxDispatcher } from "@revenge-mod/metro/common";
import { findByProps, findByName } from "@revenge-mod/metro";
import { after } from "@revenge-mod/patcher";
import { storage } from "@revenge-mod/plugins/storage";
import { React } from "@revenge-mod/metro/common";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CachedMessage {
    id: string;
    channelId: string;
    content: string;
    authorId: string;
    authorTag: string;
    timestamp: number;
    deletedAt?: number;
    editHistory?: EditEntry[];
    isDeleted?: boolean;
}

interface EditEntry {
    content: string;
    editedAt: number;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

// In-memory cache: channelId -> { messageId -> CachedMessage }
// We use storage for persistence across restarts (shallow — last N per channel).
const MAX_PER_CHANNEL = 200;
const messageCache: Record<string, Record<string, CachedMessage>> = {};

function getCached(channelId: string, messageId: string): CachedMessage | undefined {
    return messageCache[channelId]?.[messageId];
}

function setCached(channelId: string, msg: CachedMessage) {
    if (!messageCache[channelId]) messageCache[channelId] = {};
    messageCache[channelId][msg.id] = msg;

    // Trim to MAX_PER_CHANNEL
    const ids = Object.keys(messageCache[channelId]);
    if (ids.length > MAX_PER_CHANNEL) {
        delete messageCache[channelId][ids[0]];
    }
}

// ─── Flux Handlers ────────────────────────────────────────────────────────────

/**
 * Cache every message as it arrives so we have content if it later gets
 * deleted or edited.
 */
function handleMessageCreate({ message }: any) {
    if (!message?.id || !message?.channel_id) return;

    const entry: CachedMessage = {
        id: message.id,
        channelId: message.channel_id,
        content: message.content ?? "",
        authorId: message.author?.id ?? "",
        authorTag: message.author?.username ?? "Unknown",
        timestamp: Date.now(),
        editHistory: [],
        isDeleted: false,
    };

    setCached(message.channel_id, entry);
}

/**
 * When a message is updated, push the OLD content to the edit history so we
 * can show a "before → after" diff in the UI.
 */
function handleMessageUpdate({ message }: any) {
    if (!message?.id || !message?.channel_id) return;

    const prev = getCached(message.channel_id, message.id);
    if (!prev) return;

    // Only record if content actually changed
    if (prev.content === (message.content ?? "")) return;

    const editEntry: EditEntry = {
        content: prev.content,
        editedAt: Date.now(),
    };

    prev.editHistory = [...(prev.editHistory ?? []), editEntry];
    prev.content = message.content ?? "";
    setCached(message.channel_id, prev);
}

/**
 * Mark a deleted message so the renderer can show the ghost UI.
 */
function handleMessageDelete({ id, channelId }: any) {
    if (!id || !channelId) return;

    const cached = getCached(channelId, id);
    if (!cached) return;

    cached.isDeleted = true;
    cached.deletedAt = Date.now();
    setCached(channelId, cached);
}

function handleMessageDeleteBulk({ ids, channelId }: any) {
    for (const id of ids ?? []) {
        handleMessageDelete({ id, channelId });
    }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

const { Text, View } = findByProps("Text", "View") ?? {};
const { getColor } = findByProps("getColor") ?? {};

/**
 * Formats a timestamp into a short relative string like "2m ago".
 */
function relativeTime(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Renders the edit history accordion inside a patched message.
 */
function EditHistoryView({ history }: { history: EditEntry[] }) {
    const [expanded, setExpanded] = React.useState(false);

    if (!history || history.length === 0) return null;

    return React.createElement(
        View,
        { style: { marginTop: 2 } },
        React.createElement(
            Text,
            {
                style: { color: "#5865F2", fontSize: 11, marginBottom: 2 },
                onPress: () => setExpanded(e => !e),
                accessibilityRole: "button",
            },
            expanded
                ? "▾ Hide edit history"
                : `▸ ${history.length} edit${history.length > 1 ? "s" : ""} — tap to expand`
        ),
        expanded &&
            history.map((entry, i) =>
                React.createElement(
                    View,
                    {
                        key: i,
                        style: {
                            borderLeftWidth: 2,
                            borderLeftColor: "#4f545c",
                            paddingLeft: 6,
                            marginBottom: 3,
                        },
                    },
                    React.createElement(
                        Text,
                        { style: { color: "#b9bbbe", fontSize: 13, textDecorationLine: "line-through" } },
                        entry.content || "(empty)"
                    ),
                    React.createElement(
                        Text,
                        { style: { color: "#72767d", fontSize: 10 } },
                        relativeTime(entry.editedAt)
                    )
                )
            )
    );
}

/**
 * Renders the deleted-message ghost overlay.
 */
function DeletedBadge({ deletedAt }: { deletedAt?: number }) {
    return React.createElement(
        View,
        {
            style: {
                flexDirection: "row",
                alignItems: "center",
                marginTop: 2,
                paddingHorizontal: 6,
                paddingVertical: 2,
                backgroundColor: "#ed474720",
                borderRadius: 4,
                alignSelf: "flex-start",
            },
        },
        React.createElement(
            Text,
            { style: { color: "#ed4747", fontSize: 11 } },
            `🗑 Deleted${deletedAt ? " · " + relativeTime(deletedAt) : ""}`
        )
    );
}

// ─── Message Component Patch ──────────────────────────────────────────────────

let unpatchMessage: (() => void) | null = null;

function patchMessageComponent() {
    // Revenge's Metro exposes named components; "Message" is the standard chat row.
    const MessageModule = findByName("Message", false) ?? findByProps("Message")?.Message;
    if (!MessageModule) {
        console.warn("[MessageLogger] Could not find Message component — skipping render patch.");
        return;
    }

    unpatchMessage = after("render", MessageModule.prototype ?? MessageModule, function (args: any[], res: any) {
        // Extract the message object from props (path varies by Discord build)
        const msg: any =
            this?.props?.message ??
            args?.[0]?.message;

        if (!msg?.id || !msg?.channel_id) return res;

        const cached = getCached(msg.channel_id, msg.id);
        if (!cached) return res;

        const hasEdits = (cached.editHistory?.length ?? 0) > 0;
        const isDeleted = cached.isDeleted;

        if (!hasEdits && !isDeleted) return res;

        // Clone result and inject our UI below the message content
        try {
            const children: any[] = Array.isArray(res?.props?.children)
                ? [...res.props.children]
                : [res?.props?.children];

            if (isDeleted) {
                children.push(
                    React.createElement(DeletedBadge, {
                        key: "ml-deleted",
                        deletedAt: cached.deletedAt,
                    })
                );
            }

            if (hasEdits) {
                children.push(
                    React.createElement(EditHistoryView, {
                        key: "ml-edits",
                        history: cached.editHistory ?? [],
                    })
                );
            }

            return React.cloneElement(res, {}, ...children);
        } catch {
            return res;
        }
    });
}

// ─── Plugin Lifecycle ─────────────────────────────────────────────────────────

export default {
    onLoad() {
        // Subscribe to Flux events
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", handleMessageUpdate);
        FluxDispatcher.subscribe("MESSAGE_DELETE", handleMessageDelete);
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", handleMessageDeleteBulk);

        // Patch the render pipeline
        patchMessageComponent();

        console.log("[MessageLogger] Loaded.");
    },

    onUnload() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", handleMessageUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE", handleMessageDelete);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", handleMessageDeleteBulk);

        unpatchMessage?.();
        unpatchMessage = null;

        console.log("[MessageLogger] Unloaded.");
    },
};
