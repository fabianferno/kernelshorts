/**
 * Typed client for the live Palmier Pro MCP server.
 *
 * ---------------------------------------------------------------------------
 * WIRE PROTOCOL (observed against the live server on 2026-08-12, not guessed)
 * ---------------------------------------------------------------------------
 * Endpoint: http://127.0.0.1:19789/mcp — MCP Streamable HTTP.
 *
 *   1. POST {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
 *          protocolVersion, capabilities, clientInfo}}
 *      Headers: Content-Type: application/json
 *               Accept: application/json, text/event-stream
 *      -> 200, Content-Type: text/event-stream, Connection: close
 *      -> response header `MCP-Session-Id: <UUID>` (case-insensitive)
 *      -> body is SSE. Frame 1 is a bare keepalive (`id: 1_1` / `data:` empty).
 *         Frame 2 is `event: message` with the JSON-RPC response in `data:`.
 *      -> result.protocolVersion is "2025-06-18"; serverInfo.name "palmier-pro".
 *
 *   2. POST {"jsonrpc":"2.0","method":"notifications/initialized"} with the
 *      Mcp-Session-Id header -> 202 Accepted, empty body.
 *
 *   3. POST tools/list and tools/call the same way — every POST returns its own
 *      short-lived SSE body (keepalive frame + one `event: message` frame) and
 *      then closes. There is no long-lived stream to keep open.
 *
 *   GET /mcp with a session id does NOT return 405 on this build — it opens a
 *   server->client SSE stream and hangs. We never issue one; this client is
 *   purely request/response, which is all the tool surface needs.
 *
 * tools/call result envelope:
 *   success: {result:{content:[{type:"text", text:"<JSON string>"}]}}
 *   failure: {result:{content:[{type:"text", text:"Clip not found: zzz"}],
 *                     isError:true}}
 *   Note the failure text is PLAIN TEXT, not JSON. `call()` throws
 *   PalmierToolError carrying the server's exact message. It never swallows an
 *   error and never substitutes a default.
 *
 * All tool argument types below are transcribed from the real `tools/list`
 * inputSchema JSON returned by this server. No parameter is invented.
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:19789/mcp";
const PROTOCOL_VERSION = "2025-06-18";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a tools/call comes back with `isError: true`. */
export class PalmierToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "PalmierToolError";
  }
}

/** Thrown on a JSON-RPC protocol-level error (bad method, malformed request). */
export class PalmierRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "PalmierRpcError";
  }
}

/** Thrown when the canvas does not match what the caller asserted. */
export class PalmierCanvasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PalmierCanvasError";
  }
}

/** Thrown when exportAndWait exceeds its timeout or the job fails/cancels. */
export class PalmierExportError extends Error {
  constructor(
    message: string,
    readonly job?: ExportJob,
  ) {
    super(message);
    this.name = "PalmierExportError";
  }
}

// ---------------------------------------------------------------------------
// Shared types (from the real schemas)
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type Quality = "720p" | "1080p" | "2K" | "4K";
export type Interp = "linear" | "hold" | "smooth";

export type TextAnimation =
  | "off"
  | "fadeIn"
  | "popIn"
  | "slideUp"
  | "typewriter"
  | "wordReveal"
  | "wordSlide"
  | "wordPop"
  | "wordCycle"
  | "highlightPop"
  | "highlightBlock";

export type BlendMode =
  | "normal"
  | "darken"
  | "multiply"
  | "colorBurn"
  | "lighten"
  | "screen"
  | "colorDodge"
  | "overlay"
  | "softLight"
  | "hardLight"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/** Normalized 0–1 canvas coords. `width`/`height` are normalized sizes, not scale factors. */
/** CLIP transform (set_clip_properties). Still centre + size. */
export interface Transform {
  centerX?: number;
  centerY?: number;
  width?: number;
  height?: number;
  /** Clockwise degrees. */
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
}

/**
 * TEXT transform (add_texts, update_text, add_captions). Position only, and
 * named differently from the clip transform above:
 *   entries[0].transform: unknown field(s) 'centerX', 'centerY'.
 *   Allowed: rotation, rotationX, rotationY, x, y.
 *
 * Kept as its own type precisely so the two cannot be confused again. Sharing
 * `Transform` is what let a centre-named field reach a text API and fail the
 * build after every asset had already been produced. Note there is no
 * width/height: text auto-fits, and a fixed text box is no longer expressible.
 */
export interface TextTransform {
  /** 0-1 horizontal centre. */
  x?: number;
  /** 0-1 vertical centre. */
  y?: number;
  rotation?: number;
  rotationX?: number;
  rotationY?: number;
}

export interface TextStyle {
  alignment?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  overline?: boolean;
  strikethrough?: boolean;
  color?: string;
  fontCase?: "mixed" | "uppercase" | "lowercase";
  fontName?: string;
  fontSize?: number;
  heightScale?: number;
  widthScale?: number;
  lineSpacing?: number;
  tracking?: number;
  background?: {
    enabled?: boolean;
    color?: string;
    opacity?: number;
    cornerRadius?: number;
    center?: { x?: number; y?: number };
    padding?: { x?: number; y?: number };
    outline?: { color?: string; width?: number };
  };
  outline?: { enabled?: boolean; color?: string; width?: number };
  shadow?: {
    enabled?: boolean;
    color?: string;
    opacity?: number;
    blur?: number;
    offset?: { x?: number; y?: number };
  };
}

// --- per-tool argument types ------------------------------------------------

export interface ManageProjectArgs {
  action: "list" | "open" | "create" | "close";
  /** e.g. "9:16", "16:9". create only. */
  aspectRatio?: string;
  fps?: number;
  /** Project id from `manage_project {action:"list"}`. open/close. */
  id?: string;
  name?: string;
  path?: string;
  quality?: Quality;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  isOpen?: boolean;
  isActive?: boolean;
  isVisible?: boolean;
  isAccessible?: boolean;
}

export interface ManageProjectResult {
  projects?: ProjectSummary[];
  active?: { name: string; path: string };
  visible?: { name: string; path: string };
  openCount?: number;
  [k: string]: unknown;
}

export interface GetMediaArgs {
  folder?: string;
  /** Filter to specific asset ids — the cheap read for polling a url/generation import. */
  ids?: string[];
  pending?: boolean;
}

/** Exactly one of url / path / bytes / matte. */
export interface ImportSource {
  /** HTTPS only. Downloads in the background — poll get_media until generationStatus clears. */
  url?: string;
  /** Absolute local file OR directory (directories import recursively). Resolves inline. */
  path?: string;
  /** Base64. Prefer url/path over ~10MB. Requires mimeType. */
  bytes?: string;
  /** Generates a solid-color PNG instead of importing a file. */
  matte?: {
    hex: string;
    aspectRatio?: "Project" | "16:9" | "9:16" | "1:1" | "4:3" | "9:14" | "2.4:1";
  };
  /** Required with `bytes`; type-inference override for `url`. */
  mimeType?: string;
}

export interface ImportMediaArgs {
  source: ImportSource;
  folder?: string;
  name?: string;
}

export interface GetTimelineArgs {
  startFrame?: number;
  endFrame?: number;
  /** Expand caption groups into individual caption clips (windowed). */
  captionDetail?: boolean;
}

/**
 * Real shape returned by get_timeline — the project settings are FLAT on the
 * root object (not nested under a `project` key), alongside the active
 * timeline's id/name and its tracks. Verified against the live server:
 * `{canGenerate, currentFrame, durationSeconds, fps, height, id, name,
 *   totalFrames, tracks, width}`.
 */
export interface TimelineResult {
  /** Active timeline id. */
  id?: string;
  /** Active timeline name. */
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  totalFrames?: number;
  durationSeconds?: number;
  currentFrame?: number;
  /** false means the signed-in account cannot run generation or upscale calls. */
  canGenerate?: boolean;
  tracks?: Array<{ trackId?: string; index?: number; type?: string; [k: string]: unknown }>;
  clips?: Array<Record<string, unknown>>;
  notes?: string[];
  [k: string]: unknown;
}

export interface AddClipEntry {
  /** Asset id from get_media. Pass back exactly as given — ids are short prefixes. */
  mediaRef: string;
  /** TIMELINE position, in project frames. */
  startFrame: number;
  /** [startSeconds, endSeconds] of the SOURCE. Mutually exclusive with endFrame. */
  source?: [number, number];
  /** Occupy timeline frames [startFrame, endFrame). Mutually exclusive with source. */
  endFrame?: number;
  /**
   * 0-based, index 0 renders on top. OMITTING this on every entry auto-creates a
   * shared track per asset zone — which SHIFTS existing track indices. See
   * `addClips` doc comment.
   */
  trackIndex?: number;
}

export interface SetClipPropertiesArgs {
  clipIds: string[];
  transform?: Transform;
  opacity?: number;
  speed?: number;
  volumeDb?: number;
  blendMode?: BlendMode;
  durationFrames?: number;
  trimStartFrame?: number;
  trimEndFrame?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  fadeInInterpolation?: "linear" | "smooth";
  fadeOutInterpolation?: "linear" | "smooth";
  edgeRounding?: number;
  edgeSoftness?: number;
}

export interface AddCaptionsArgs {
  trackIndex?: number;
  maxWords?: number;
  maximumGapSeconds?: number;
  language?: string;
  censorProfanity?: boolean;
  animation?: TextAnimation;
  highlightColor?: string;
  style?: TextStyle;
  /**
   * Position only, spelled `x`/`y` — same for add_texts entries.
   *
   * Palmier's advertised schema still documents centerX/centerY here, but the
   * running validator rejects them:
   *   add_captions.transform: unknown field(s) 'centerX', 'centerY'.
   *   Allowed: rotation, rotationX, rotationY, x, y.
   * The runtime is what builds the video, so the runtime wins. Same 0-1
   * normalised centre semantics; only the field names differ. set_clip_
   * properties is NOT affected and still uses centerX/centerY + width/height.
   */
  transform?: TextTransform;
}

export interface AddTextEntry {
  content: string;
  startFrame: number;
  endFrame: number;
  trackIndex?: number;
  animation?: TextAnimation;
  /** 'footage' stencils the layers below through the letter shapes. */
  fillMode?: "color" | "footage";
  highlightColor?: string;
  style?: TextStyle;
  transform?: TextTransform;
}

/**
 * Keyframe rows are `[frame, ...values, interp?]`. Frames are CLIP-RELATIVE
 * (0 = the clip's first frame), so keyframes travel with the clip.
 *   volumeDb `[frame, dB]`            dB in −60..+15 (−60 = mute)
 *   opacity  `[frame, 0..1]`
 *   rotation `[frame, degrees]`       clockwise
 *   position `[frame, topLeftX, topLeftY]`   TOP-LEFT, normalized 0–1. NOT centre.
 *   scale    `[frame, width, height]` normalized 0–1 sizes. NOT a scale factor.
 *   crop     `[frame, top, right, bottom, left]`  insets, 0–1 of the source.
 */
export type KeyframeProperty = "volumeDb" | "opacity" | "rotation" | "position" | "scale" | "crop";
export type KeyframeRow = Array<number | Interp>;

export interface SetKeyframesArgs {
  clipId: string;
  property: KeyframeProperty;
  /** Replaces the whole track for that property. Empty array clears it. */
  keyframes: KeyframeRow[];
}

export interface ApplyEffectArgs {
  clipIds: string[];
  effects?: Array<{ type: string; enabled?: boolean; params?: Record<string, unknown> }>;
  /** Effect types to remove. */
  remove?: string[];
}

export interface ExportProjectArgs {
  mode?: "video" | "xml" | "fcpxml" | "palmier";
  codec?: "H.264" | "H.265" | "ProRes";
  resolution?: Quality | "Match Timeline";
  /** Absolute path. Omit to write a unique file to ~/Downloads. */
  outputPath?: string;
  /** Direct outputPath files are overwritten by default; false refuses. */
  overwrite?: boolean;
  fcpxmlTarget?: "resolve" | "fcp";
  timelineId?: string;
}

export interface ExportProjectResult {
  jobId: string;
  status: string;
  path?: string;
  [k: string]: unknown;
}

export interface ExportJob {
  jobId: string;
  filename?: string;
  path?: string;
  /** Real observed value: "completed". Also "waiting" | "rendering" | "failed" | "canceled". */
  status: string;
  progress?: number;
  warnings?: unknown;
  result?: unknown;
  [k: string]: unknown;
}

export interface ManageExportsArgs {
  action: "list" | "cancel";
  /** Required for cancel — the exact jobId from export_project or list. */
  jobId?: string;
}

export interface ManageExportsResult {
  exports?: ExportJob[];
  [k: string]: unknown;
}

export interface GetTranscriptArgs {
  trackIndex?: number;
  clipId?: string;
  startFrame?: number;
  endFrame?: number;
  granularity?: "words" | "segments";
  /** BCP-47. Omit unless the spoken language is known — cloud auto-detects. */
  language?: string;
}

export interface CreateTimelineArgs {
  name?: string;
  /** Source timeline id to copy from. */
  from?: string;
}

export interface SetProjectSettingsArgs {
  width?: number;
  height?: number;
  fps?: number;
  aspectRatio?: string;
  quality?: Quality;
}

export interface ManageTracksArgs {
  /** Prefer stable trackId over index — indices shift. */
  set?: Array<{
    trackId?: string;
    index?: number;
    hidden?: boolean;
    muted?: boolean;
    syncLocked?: boolean;
  }>;
  reorder?: Array<{ to: number; trackId?: string; index?: number }>;
  remove?: Array<{ trackId?: string }>;
}

export interface MoveClipsArgs {
  moves: Array<{ clipId: string; toFrame?: number; toTrack?: number }>;
}

export interface UpdateTextArgs {
  /** Restyle a whole caption group at once (id comes back from add_captions). */
  captionGroupId?: string;
  clipIds?: string[];
  content?: string;
  animation?: TextAnimation;
  fillMode?: "color" | "footage";
  highlightColor?: string;
  style?: TextStyle;
  transform?: TextTransform;
}

/** Generic mutation delta — every edit tool returns this shape. */
export interface EditResult {
  clips?: Array<Record<string, unknown>>;
  shifted?: Array<{ track: number; fromFrame: number; by: number; count: number }>;
  removedClipIds?: string[];
  createdTracks?: unknown[];
  notes?: string[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Parse a Streamable-HTTP SSE body into its JSON-RPC messages.
 *
 * The server emits a bare keepalive frame (`data:` with an empty payload)
 * before the real `event: message` frame, so blank payloads are skipped.
 * Multi-line `data:` fields are joined with newlines per the SSE spec.
 */
export function parseSseMessages(body: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const rawFrame of body.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of rawFrame.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const payload = dataLines.join("\n").trim();
    if (payload === "") continue;
    out.push(JSON.parse(payload) as JsonRpcResponse);
  }
  return out;
}

export interface PalmierClientOptions {
  endpoint?: string;
  clientName?: string;
  clientVersion?: string;
  /** Per-request timeout in ms. Renders are polled separately, so this is the RPC timeout. */
  requestTimeoutMs?: number;
}

export class PalmierClient {
  readonly endpoint: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly requestTimeoutMs: number;

  private nextId = 1;
  private _sessionId: string | undefined;
  private _serverInfo: { name?: string; version?: string } | undefined;
  private _tools: McpTool[] | undefined;

  constructor(opts: PalmierClientOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.clientName = opts.clientName ?? "kernelshorts";
    this.clientVersion = opts.clientVersion ?? "0.1.0";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get serverInfo(): { name?: string; version?: string } | undefined {
    return this._serverInfo;
  }

  // --- transport primitives -------------------------------------------------

  private async post(payload: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this._sessionId) headers["Mcp-Session-Id"] = this._sessionId;
    if (this._sessionId) headers["MCP-Protocol-Version"] = PROTOCOL_VERSION;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new PalmierRpcError(
        `Palmier MCP HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 500)}`,
        res.status,
      );
    }
    return res;
  }

  /** Issue a JSON-RPC request and return its `result`, throwing on rpc errors. */
  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });

    // The session id is only issued on the initialize response.
    const sid = res.headers.get("mcp-session-id");
    if (sid) this._sessionId = sid;

    // Read incrementally and resolve on the FIRST message matching our id.
    //
    // Do not use `await res.text()` here: that waits for the stream to END, not
    // for the reply to ARRIVE. The server closes the stream promptly for cheap
    // calls but holds it open after slower ones (import_media reproducibly hung
    // for the full request timeout even though all nine imports had already
    // succeeded — the app showed mediaCount 9 while the client sat waiting).
    const match = await this.readUntilId(res, id, method);
    if (match.error) {
      throw new PalmierRpcError(
        `${method} failed: ${match.error.message}`,
        match.error.code,
        match.error.data,
      );
    }
    return match.result;
  }

  /**
   * Consumes an SSE body chunk by chunk, returning as soon as a JSON-RPC
   * message with the requested id appears, then cancelling the rest of the
   * stream. Frames are separated by a blank line; a partial trailing frame is
   * carried over to the next chunk.
   */
  private async readUntilId(
    res: Response,
    id: number,
    method: string,
  ): Promise<JsonRpcResponse> {
    if (!res.body) throw new PalmierRpcError(`${method}: response had no body`, -1);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let seen = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          seen += buffer.slice(-2000);
        }

        // Only parse whole frames; keep any partial tail in the buffer.
        const boundary = buffer.lastIndexOf("\n\n");
        if (boundary !== -1) {
          const complete = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          const match = parseSseMessages(complete).find((m) => m.id === id);
          if (match) return match;
        }

        if (done) {
          const match = parseSseMessages(buffer).find((m) => m.id === id);
          if (match) return match;
          throw new PalmierRpcError(
            `No JSON-RPC response for id ${id} (${method}) before the stream ` +
              `closed. Last bytes: ${seen.slice(-500)}`,
            -1,
          );
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  // --- lifecycle ------------------------------------------------------------

  /** Run the MCP handshake: initialize -> capture session id -> notifications/initialized. */
  async connect(): Promise<void> {
    const result = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    })) as { serverInfo?: { name?: string; version?: string } };

    if (!this._sessionId) {
      throw new PalmierRpcError("Palmier MCP did not return an Mcp-Session-Id header", -1);
    }
    this._serverInfo = result.serverInfo;
    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list")) as { tools: McpTool[] };
    this._tools = result.tools;
    return result.tools;
  }

  /**
   * Call a tool and return its parsed JSON payload.
   *
   * Throws `PalmierToolError` with the server's exact message when the envelope
   * carries `isError: true`. Never returns a default and never swallows.
   */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };

    const text = (result.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");

    if (result.isError) {
      throw new PalmierToolError(name, text || `${name} failed with no message`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    if (text === "") return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      // Some tools answer with prose rather than JSON. Surface it verbatim.
      return text as unknown as T;
    }
  }

  /**
   * Drop the session. The server has no explicit shutdown RPC; a DELETE on the
   * endpoint is the Streamable-HTTP session teardown. Failure to tear down is
   * not fatal — the session expires on its own — so it is reported, not thrown.
   */
  async close(): Promise<void> {
    if (!this._sessionId) return;
    try {
      await fetch(this.endpoint, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": this._sessionId },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Session will time out server-side; nothing recoverable to do here.
    }
    this._sessionId = undefined;
    this._tools = undefined;
  }

  // -------------------------------------------------------------------------
  // Typed tool wrappers — arguments transcribed from the live tools/list schema
  // -------------------------------------------------------------------------

  /**
   * Choose which project this session edits. `create` with
   * `{aspectRatio:"9:16", quality:"1080p", fps:30}` yields a 1080x1920 canvas —
   * no pre-made template needed. `close` saves and closes; it never deletes.
   */
  manageProject(args: ManageProjectArgs): Promise<ManageProjectResult> {
    return this.call<ManageProjectResult>("manage_project", args as unknown as Record<string, unknown>);
  }

  /** List assets. Poll a background url import with `{ids:[placeholderId]}`. */
  getMedia(args: GetMediaArgs = {}): Promise<Record<string, unknown>> {
    return this.call("get_media", args as unknown as Record<string, unknown>);
  }

  /**
   * Import an asset. `path` (file or directory) resolves inline; `url` (HTTPS)
   * downloads in the background — poll `getMedia({ids})` until generationStatus
   * clears. webm is rejected: transcode Playwright captures to H.264 MP4 first.
   */
  importMedia(args: ImportMediaArgs): Promise<Record<string, unknown>> {
    return this.call("import_media", args as unknown as Record<string, unknown>);
  }

  /**
   * Read project settings, tracks (with stable trackId + current index) and clips.
   * Call once per session — every mutation returns a delta in this vocabulary.
   * Re-read after any track-creating call (see addClips/addCaptions/addTexts).
   */
  getTimeline(args: GetTimelineArgs = {}): Promise<TimelineResult> {
    return this.call<TimelineResult>("get_timeline", args as unknown as Record<string, unknown>);
  }

  /**
   * Place clips on the timeline.
   *
   * TRACK INDICES SHIFT: an entry without `trackIndex` auto-creates a track, and
   * every existing index below it moves. After any such call the caller MUST
   * re-read `getTimeline()` (or address tracks by stable `trackId`) before the
   * next index-based call. The response's `createdTracks` / `notes` tell you
   * whether it happened.
   *
   * CANVAS HIJACK: the first `add_clips` of landscape media silently re-sets the
   * project canvas to the media's resolution, with only an advisory note. Follow
   * a first import with `setProjectSettings({width, height})` and then
   * `assertCanvas(width, height)`.
   */
  addClips(entries: AddClipEntry[]): Promise<EditResult> {
    return this.call<EditResult>("add_clips", { entries });
  }

  /**
   * Single-clip properties. NOT for split-screen/PIP/grid — that is apply_layout.
   * A 16:9 source auto-fits letterboxed into 9:16 at `transform.height ≈ 0.316`;
   * set `transform {width: 3.165, height: 1}` to fill the frame instead.
   */
  setClipProperties(args: SetClipPropertiesArgs): Promise<EditResult> {
    return this.call<EditResult>("set_clip_properties", args as unknown as Record<string, unknown>);
  }

  /**
   * Transcribe the timeline's spoken audio into caption clips, returning a
   * `captionGroupId` you can restyle wholesale with `updateText`.
   *
   * TRACK INDICES SHIFT: this creates a new top video track. Re-read
   * `getTimeline()` before the next index-based call.
   */
  addCaptions(args: AddCaptionsArgs = {}): Promise<EditResult> {
    return this.call<EditResult>("add_captions", args as unknown as Record<string, unknown>);
  }

  /**
   * Authored text overlays.
   *
   * TRACK INDICES SHIFT when `trackIndex` is omitted — a new video track is
   * created. Re-read `getTimeline()` afterwards.
   */
  addTexts(entries: AddTextEntry[]): Promise<EditResult> {
    return this.call<EditResult>("add_texts", { entries });
  }

  /** Replace the keyframe track for one property of one clip. See KeyframeRow docs. */
  setKeyframes(args: SetKeyframesArgs): Promise<EditResult> {
    return this.call<EditResult>("set_keyframes", args as unknown as Record<string, unknown>);
  }

  /** Add or remove clip effects. Colour grading belongs to apply_color, not here. */
  applyEffect(args: ApplyEffectArgs): Promise<EditResult> {
    return this.call<EditResult>("apply_effect", args as unknown as Record<string, unknown>);
  }

  /**
   * Queue an export. Always returns `{jobId, status}` — the render runs in the
   * background. Poll with `manageExports({action:"list"})` or use `exportAndWait`.
   * Palmier does NOT loudness-normalize; run ffmpeg loudnorm over the output
   * before publishing.
   */
  exportProject(args: ExportProjectArgs = {}): Promise<ExportProjectResult> {
    return this.call<ExportProjectResult>("export_project", args as unknown as Record<string, unknown>);
  }

  /** List (newest first) or cancel export jobs for the current project. */
  manageExports(args: ManageExportsArgs): Promise<ManageExportsResult> {
    return this.call<ManageExportsResult>("manage_exports", args as unknown as Record<string, unknown>);
  }

  /**
   * Word- or segment-level transcript. Word rows are `[index, text, startFrame]`
   * in PROJECT FRAMES; a word runs until the next word's start.
   */
  getTranscript(args: GetTranscriptArgs = {}): Promise<Record<string, unknown>> {
    return this.call("get_transcript", args as unknown as Record<string, unknown>);
  }

  /** Create an additional timeline in the current project (optionally copied from another). */
  createTimeline(args: CreateTimelineArgs = {}): Promise<Record<string, unknown>> {
    return this.call("create_timeline", args as unknown as Record<string, unknown>);
  }

  /** Change canvas size / fps. The remedy for the add_clips canvas hijack. */
  setProjectSettings(args: SetProjectSettingsArgs): Promise<Record<string, unknown>> {
    return this.call("set_project_settings", args as unknown as Record<string, unknown>);
  }

  /**
   * Mute/hide/reorder/remove tracks.
   *
   * TRACK INDICES SHIFT on reorder and remove — pass stable `trackId` values
   * rather than indices, and re-read `getTimeline()` after the call.
   */
  manageTracks(args: ManageTracksArgs): Promise<EditResult> {
    return this.call<EditResult>("manage_tracks", args as unknown as Record<string, unknown>);
  }

  /** Move clips to a new frame and/or track. `toTrack` is a current index — read it fresh. */
  moveClips(moves: MoveClipsArgs["moves"]): Promise<EditResult> {
    return this.call<EditResult>("move_clips", { moves });
  }

  /** Delete clips, leaving gaps (no ripple). Throws if any id is unknown. */
  removeClips(args: { clipIds: string[] }): Promise<EditResult> {
    return this.call<EditResult>("remove_clips", args as unknown as Record<string, unknown>);
  }

  /** Restyle/retext existing text or a whole caption group by `captionGroupId`. */
  updateText(args: UpdateTextArgs): Promise<EditResult> {
    return this.call<EditResult>("update_text", args as unknown as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // Guardrails
  // -------------------------------------------------------------------------

  /**
   * Verify the project canvas is exactly `width` x `height`, throwing otherwise.
   *
   * WHY THIS EXISTS (M0 spike finding): placing the first landscape clip
   * silently re-sets the project canvas to the media's resolution — a 9:16
   * project created at 1080x1920 became 1280x720 after one `add_clips`, with
   * only an advisory `note` in the response. A worker that trusts its
   * create-time settings would happily export a landscape "short".
   *
   * So the mandatory sequence after the first add_clips of a run is:
   *   await client.setProjectSettings({ width: 1080, height: 1920 });
   *   await client.assertCanvas(1080, 1920);
   * A mismatch is a hard failure, not something to auto-repair silently.
   */
  async assertCanvas(width: number, height: number): Promise<void> {
    const timeline = await this.getTimeline();
    const actualW = timeline.width;
    const actualH = timeline.height;
    if (actualW !== width || actualH !== height) {
      throw new PalmierCanvasError(
        `Canvas is ${actualW}x${actualH}, expected ${width}x${height}. ` +
          `Palmier silently re-sets the canvas to the resolution of the first ` +
          `clip added; re-assert with setProjectSettings({width, height}).`,
      );
    }
  }

  /**
   * Export and block until the render leaves the queue.
   *
   * Polls `manage_exports {action:"list"}` for the job. Resolves with the
   * completed job; throws `PalmierExportError` on failure, cancellation, the
   * job disappearing from the queue, or timeout. Never resolves on a
   * still-rendering job.
   */
  async exportAndWait(
    outputPath: string,
    args: Omit<ExportProjectArgs, "outputPath"> = {},
    opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<ExportJob> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    const timeoutMs = opts.timeoutMs ?? 20 * 60_000;

    const queued = await this.exportProject({ ...args, outputPath });
    if (!queued?.jobId) {
      throw new PalmierExportError(
        `export_project returned no jobId: ${JSON.stringify(queued)}`,
      );
    }

    const deadline = Date.now() + timeoutMs;
    let lastStatus = queued.status;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const list = await this.manageExports({ action: "list" });
      const job = (list.exports ?? []).find((j) => j.jobId === queued.jobId);

      if (!job) {
        throw new PalmierExportError(
          `Export job ${queued.jobId} vanished from the queue (last status "${lastStatus}"). ` +
            `The render did not complete.`,
        );
      }
      lastStatus = job.status;

      const status = job.status.toLowerCase();
      if (status === "completed" || status === "complete" || status === "finished") {
        return job;
      }
      if (status.includes("fail") || status.includes("cancel") || status === "error") {
        throw new PalmierExportError(
          `Export job ${job.jobId} ended with status "${job.status}"` +
            (job.warnings ? ` — warnings: ${JSON.stringify(job.warnings)}` : ""),
          job,
        );
      }
      // waiting / queued / started / rendering / exporting -> keep polling
    }

    throw new PalmierExportError(
      `Export job ${queued.jobId} did not finish within ${timeoutMs}ms ` +
        `(last status "${lastStatus}"). Not treating a slow render as success.`,
    );
  }
}
