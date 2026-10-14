import { execFile } from "node:child_process";
import path from "node:path";
import type { SpeechSynthesisProvider, LocalSpeechVoice } from "../../application/ports/speech-synthesis.js";
import { AutoEditBlocked } from "../../domain/auto-edit.js";

export class LinuxSpeechSynthesis implements SpeechSynthesisProvider {
  readonly id = "linux-espeak-ng-v1";
  private run(args: string[], text?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile("/usr/bin/espeak-ng", args, { timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) reject(new AutoEditBlocked("LOCAL_SPEECH_UNAVAILABLE", "Linux 离线语音不可用，请上传旁白音频或保留原视频声音", true));
        else resolve(String(stdout));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(text ?? "");
    });
  }
  async voices(): Promise<LocalSpeechVoice[]> {
    await this.run(["--version"]);
    return [{ name: "cmn", locale: "zh-CN", enabled: true }];
  }
  async synthesize(input: { text: string; voiceName: string; rate: number; outputPath: string }): Promise<void> {
    if (!input.text.trim() || input.text.length > 2000 || input.voiceName !== "cmn" ||
        !Number.isInteger(input.rate) || input.rate < -2 || input.rate > 3 ||
        !path.isAbsolute(input.outputPath) || path.extname(input.outputPath).toLowerCase() !== ".wav")
      throw new AutoEditBlocked("INVALID_NARRATION", "旁白文本、音色、语速或输出路径无效", true);
    await this.run(["-v", "cmn", "-s", String(150 + input.rate * 20), "-w", input.outputPath, "--stdin"], input.text);
  }
}
