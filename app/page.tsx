import Link from "next/link";
import { tools } from "./lib/tools";

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="eyebrow">FREE · PRIVATE · BROWSER-BASED</div>
        <h1>Free video tools.<br /><em>No signup. No watermark.</em></h1>
        <p>Edit, convert, compress and create videos directly in your browser. Your files stay on your device.</p>
        <a className="primary" href="#tools">Explore free tools</a>
      </section>

      <section className="tools" id="tools">
        <div className="section-heading"><div><span>THE TOOLBOX</span><h2>Everything you need for quick video work</h2></div><p>Simple tools, focused results, zero friction.</p></div>
        <div className="grid">
          {tools.map((tool) => (
            <Link className="card" href={`/tools/${tool.slug}`} key={tool.slug}>
              <div className="icon">{tool.icon}</div>
              <div><h3>{tool.title}</h3><p>{tool.description}</p></div>
              <span className={tool.status === "ready" ? "badge ready" : "badge"}>{tool.status === "ready" ? "Live" : "Next"}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="privacy" id="privacy">
        <div><span className="shield">✓</span></div>
        <div><span>PRIVACY BY DESIGN</span><h2>Your videos remain yours.</h2><p>Processing happens locally in your browser whenever possible. Files are not uploaded to our servers, and you do not need an account.</p></div>
      </section>
    </>
  );
}
