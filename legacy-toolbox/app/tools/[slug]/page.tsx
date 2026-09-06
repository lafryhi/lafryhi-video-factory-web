import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTool, tools } from "../../lib/tools";
import { ToolWorkspace } from "../../components/ToolWorkspace";

export function generateStaticParams() {
  return tools.map((tool) => ({ slug: tool.route.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const tool = getTool(slug);
  return tool ? tool.seo : {};
}

export default async function ToolPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tool = getTool(slug);
  if (!tool) notFound();

  return (
    <section className="tool-page">
      <div className="tool-title"><div className="icon large">{tool.icon}</div><span>FREE ONLINE TOOL</span><h1>{tool.title}</h1><p>{tool.helperText ?? `${tool.description} No signup and no watermark.`}</p></div>
      <ToolWorkspace tool={tool} />
      <div className="how"><h2>How it works</h2><div><article><b>1</b><h3>Select your file</h3><p>Choose a file from your phone or computer.</p></article><article><b>2</b><h3>Process privately</h3><p>The browser performs the work on your device.</p></article><article><b>3</b><h3>Download the result</h3><p>Save the finished file immediately.</p></article></div></div>
    </section>
  );
}
