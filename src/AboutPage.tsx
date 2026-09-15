import { Download, Github, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import type { UpdateInfo, UpdateProgress } from "./bridge";

export function AboutPage({
  version,
  update,
  checked,
  checking,
  updating,
  progress,
  onCheck,
  onInstall,
}: {
  version: string;
  update: UpdateInfo | null;
  checked: boolean;
  checking: boolean;
  updating: boolean;
  progress: UpdateProgress | null;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const percent = progress?.total
    ? Math.min(100, Math.round(progress.downloaded / progress.total * 100))
    : 0;
  const status = updating
    ? progress?.total ? `\u6b63\u5728\u4e0b\u8f7d ${percent}%` : "\u6b63\u5728\u51c6\u5907\u66f4\u65b0"
    : update
      ? `\u53d1\u73b0\u65b0\u7248\u672c ${update.version}`
      : checking
        ? "\u6b63\u5728\u68c0\u67e5\u66f4\u65b0"
        : checked
          ? "\u5f53\u524d\u5df2\u662f\u6700\u65b0\u7248\u672c"
          : "\u7b49\u5f85\u68c0\u67e5";
  const statusTone = updating ? "busy" : update ? "available" : checking ? "checking" : checked ? "current" : "idle";
  return <div id="about-page" className="about-page" role="tabpanel">
    <section className="about-hero">
      <div className="about-logo"><ShieldCheck size={26} /></div>
      <div>
        <span className="about-kicker">{"\u672c\u5730\u8fd0\u884c \u00b7 \u9690\u79c1\u4f18\u5148"}</span>
        <h1>Moyu Sentinel</h1>
        <p>{"\u672c\u5730\u6444\u50cf\u5934\u4eba\u5f62\u68c0\u6d4b\u4e0e\u684c\u9762\u63d0\u9192\u5de5\u5177"}</p>
      </div>
      <span className="about-version">v{version}</span>
    </section>
    <section className="about-card">
      <div className="about-section-heading">
        <div><RefreshCw size={18} /><strong>{"\u8f6f\u4ef6\u66f4\u65b0"}</strong></div>
        <span className={`about-status ${statusTone}`}>{status}</span>
      </div>
      <p className="about-description">
        {"\u542f\u52a8\u65f6\u4f1a\u81ea\u52a8\u68c0\u67e5 GitHub \u6700\u65b0\u53d1\u5e03\uff1b\u66f4\u65b0\u65f6\u4f1a\u6821\u9a8c SHA-256\uff0c\u5e76\u4fdd\u7559 MoyuSentinel-data \u914d\u7f6e\u76ee\u5f55\u3002"}
      </p>
      {update && <div className="about-update-version">
        <strong>v{update.version}</strong>
        <span>{update.notes.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "\u5efa\u8bae\u66f4\u65b0\u5230\u6700\u65b0\u7248\u672c"}</span>
      </div>}
      <div className="about-tags"><span>{"\u81ea\u52a8\u68c0\u67e5"}</span><span>SHA-256 {"\u6821\u9a8c"}</span><span>{"\u4fdd\u7559\u914d\u7f6e"}</span></div>
      <div className="about-actions">
        <button className="secondary-button" type="button" disabled={checking || updating} onClick={onCheck}>
          <RefreshCw size={15} className={checking ? "spinning" : ""} />
          {checking ? "\u6b63\u5728\u68c0\u67e5" : "\u68c0\u67e5\u66f4\u65b0"}
        </button>
        {update && <button className="primary-button" type="button" disabled={updating} onClick={onInstall}>
          <Download size={15} />
          {updating ? (progress?.total ? `\u4e0b\u8f7d\u4e2d ${percent}%` : "\u6b63\u5728\u51c6\u5907") : "\u4e0b\u8f7d\u5e76\u5b89\u88c5"}
        </button>}
      </div>
    </section>
    <section className="about-card author-card">
      <div className="about-section-heading">
        <div><UserRound size={18} /><strong>{"\u4f5c\u8005"}</strong></div>
      </div>
      <div className="author-profile">
        <div className="author-avatar">M</div>
        <div>
          <strong>mchao123</strong>
          <span>{"\u9879\u76ee\u4f5c\u8005"}</span>
        </div>
      </div>
      <p className="about-description">{"\u5982\u679c\u8fd9\u4e2a\u5de5\u5177\u5bf9\u4f60\u6709\u5e2e\u52a9\uff0c\u6b22\u8fce\u5728 GitHub \u4e0a\u5173\u6ce8\u548c\u53cd\u9988\u95ee\u9898\u3002"}</p>
      <div className="author-link"><Github size={16} /><code>github.com/mchao123</code></div>
    </section>
  </div>;
}