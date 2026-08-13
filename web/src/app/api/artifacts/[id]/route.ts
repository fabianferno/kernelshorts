import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getArtifactStream } from "@worker/run/artifacts";
import { artifactDownloadName } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Serves an artifact blob out of GridFS.
 *
 * This route exists because exports live on the worker's local disk
 * (`~/pipeline/runs/<date>/exports/*.mp4`) and a hosted control plane cannot
 * read that filesystem. `putArtifact` is what puts them within reach; this is
 * the only way back out.
 *
 * Range support is not a nicety: Chrome and Safari will not scrub a <video>
 * they were served as a single 200, and Safari in particular probes with
 * `bytes=0-1` before it will play at all. `resolveRange` in artifacts.ts owns
 * the inclusive/exclusive arithmetic; this handler only parses the header.
 */

/** `bytes=START-END`, either side optional. Multi-range (`a-b,c-d`) is legal
 *  HTTP that no video element sends and that a single stream cannot answer, so
 *  it is refused rather than silently served as the first range. */
function parseRange(header: string | null): { start?: number; end?: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  // A suffix range (`bytes=-500`) means "the last 500 bytes" — a different
  // computation from a start offset, and nothing we serve requests it.
  if (rawStart === "") return undefined;
  return {
    start: Number(rawStart),
    end: rawEnd === "" ? undefined : Number(rawEnd),
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: `Not an artifact id: ${id}` }, { status: 400 });
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader && !parseRange(rangeHeader)) {
    return NextResponse.json(
      { error: `Unsupported Range header: ${rangeHeader}` },
      { status: 416 },
    );
  }
  const range = parseRange(rangeHeader);

  let artifact;
  try {
    artifact = await getArtifactStream(id, range);
  } catch (error) {
    if (error instanceof RangeError) {
      return new NextResponse(null, { status: 416, headers: { "accept-ranges": "bytes" } });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 404 });
  }

  const { stream, contentType, sizeBytes, start, end } = artifact;
  const length = end - start + 1;
  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(length),
    "accept-ranges": "bytes",
    // Blobs are immutable: `putArtifact` gives a re-upload a new _id rather
    // than mutating one, so the URL can be cached hard.
    "cache-control": "private, max-age=31536000, immutable",
  });
  if (range) headers.set("content-range", `bytes ${start}-${end}/${sizeBytes}`);

  /**
   * `?download=1` is what the delivery panel's download button hits. It is a
   * separate URL from the one the <video> plays because Content-Disposition:
   * attachment on the player's src would stop it playing entirely — the same
   * bytes have to be reachable both ways.
   *
   * The name comes from the run record, never the request. `filename*` carries
   * the real UTF-8 name per RFC 5987 and plain `filename` is the ASCII fallback;
   * quotes and backslashes are stripped rather than escaped because a filename
   * containing them is not one we ever generate.
   */
  if (new URL(request.url).searchParams.get("download") === "1") {
    const name = (await artifactDownloadName(id)) ?? "artifact";
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
    headers.set(
      "content-disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
  }

  return new NextResponse(Readable.toWeb(stream as Readable) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
}

/**
 * Safari issues HEAD before it will commit to a media element; it wants the
 * size and Accept-Ranges, nothing else.
 *
 * `artifacts.ts` exposes no metadata-only lookup, so this asks for one byte and
 * destroys the stream rather than delegating to GET — GET would open a download
 * stream over the whole 44 MB blob and drop it on the floor, leaking a cursor
 * per HEAD.
 */
export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) return new NextResponse(null, { status: 400 });
  try {
    const { stream, contentType, sizeBytes } = await getArtifactStream(id, { start: 0, end: 0 });
    (stream as Readable).destroy();
    return new NextResponse(null, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(sizeBytes),
        "accept-ranges": "bytes",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
