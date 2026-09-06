import Link from "next/link";
import { TOOL_STATUS_BADGE_CLASSES, TOOL_STATUS_LABELS, tools } from "./lib/tools";

export default function Home() {
  const availableTools = ["Merge Videos", "Trim Video", "Cinematic Transition"];
  const plannedTools = [
    "Compress Video",
    "Remove Audio",
    "Convert to MP4",
    "Extract Audio",
    "Resize for Social Media",
    "Video Speed",
    "Reverse Video",
    "Image to Video",
  ];

  return (
    <>
      <section className="hero">
        <div className="eyebrow">VERSION 1.1 · FREE · PRIVATE · BROWSER-BASED</div>
        <h1>Free video tools.<br /><em>No signup. No watermark.</em></h1>
        <p>Version 1.1 includes three browser-based tools: Merge Videos, Trim Video and Cinematic Transition. Your files stay on your device.</p>
        <a className="primary" href="#tools">Explore free tools</a>
      </section>

      <section className="tools" id="tools">
        <div className="section-heading"><div><span>THE TOOLBOX · V1.1</span><h2>Three tools available now</h2></div><p>Merge, trim and connect mixed media today. Additional tools are planned for future releases.</p></div>
        <div className="grid">
          {tools.map((tool) => (
            <Link className="card" href={tool.route.path} key={tool.route.slug}>
              <div className="icon">{tool.icon}</div>
              <div><h3>{tool.title}</h3><p>{tool.description}</p></div>
              <span className={TOOL_STATUS_BADGE_CLASSES[tool.status]}>{TOOL_STATUS_LABELS[tool.status]}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="roadmap" id="roadmap">
        <div className="section-heading">
          <div><span>ACTIVE DEVELOPMENT</span><h2>Roadmap</h2></div>
          <p>We&apos;re continuously adding new professional video tools. Come back regularly to discover new releases.</p>
        </div>
        <div className="roadmap-grid">
          <article>
            <span>AVAILABLE NOW</span>
            <ul>
              {availableTools.map((tool) => <li className="available" key={tool}><span aria-hidden="true">✓</span>{tool}</li>)}
            </ul>
          </article>
          <article>
            <span>COMING SOON</span>
            <ul>
              {plannedTools.map((tool) => <li key={tool}>{tool}</li>)}
            </ul>
          </article>
        </div>
      </section>

      <section className="release">
        <div className="section-heading">
          <div><span>CHANGELOG</span><h2>Latest Release</h2></div>
          <p>A compact view of what shipped and what is planned next.</p>
        </div>
        <div className="release-grid">
          <article>
            <span>v1.1</span>
            <h3>Cinematic Transition</h3>
            <ul><li>Connect images and videos with automatic cinematic movement, smooth crossfades and synchronized audio.</li></ul>
          </article>
          <article>
            <span>ALSO AVAILABLE</span>
            <h3>v1.0</h3>
            <ul><li>Merge Videos</li><li>Trim Video</li></ul>
          </article>
        </div>
      </section>

      <section className="privacy" id="privacy">
        <div><span className="shield">✓</span></div>
        <div><span>PRIVACY BY DESIGN</span><h2>Your videos remain yours.</h2><p>Processing happens locally in your browser whenever possible. Files are not uploaded to our servers, and you do not need an account.</p></div>
      </section>
    </>
  );
}
