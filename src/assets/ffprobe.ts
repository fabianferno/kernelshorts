import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type MediaInfo = {
  /** Undefined for stills, which legitimately have no duration. */
  durationS?: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  hasAudio: boolean;
};

/** Real ffprobe on a real file. Every dimension in the manifest comes from here,
 *  never from what an API claimed (PRD §0: evidence of realness). */
export async function probeMedia(path: string): Promise<MediaInfo> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", path,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      duration?: string;
    }>;
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  const a = data.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  const duration = Number(data.format?.duration ?? v?.duration ?? NaN);
  return {
    durationS: Number.isFinite(duration) ? duration : undefined,
    width: v?.width,
    height: v?.height,
    fps: num && den ? Math.round((num / den) * 1000) / 1000 : undefined,
    videoCodec: v?.codec_name,
    hasAudio: Boolean(a),
  };
}

/** Raw ffprobe text, for pasting into run evidence. */
export async function probeDump(path: string): Promise<string> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-show_entries",
    "stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames:format=duration,size",
    "-of", "default=noprint_wrappers=1",
    path,
  ]);
  return stdout.trim();
}
