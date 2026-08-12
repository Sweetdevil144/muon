import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders assistant (and optionally user) bodies as GitHub-flavored markdown.
 * react-markdown does not execute raw HTML by default — keep it that way.
 */
export function ChatMarkdown(props: { text: string }) {
  return (
    <div className="msg-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Model-authored URLs are untrusted data. The Desktop has no generic
          // external-navigation IPC, so keep their labels readable but inert.
          a: ({ children }) => (
            <span className="msg-markdown-link">{children}</span>
          ),
          // Never let model-authored Markdown trigger an ambient network fetch.
          // The alt text remains visible so the omission is understandable.
          img: ({ alt }) => (
            <span className="msg-markdown-image">
              [image omitted{alt ? `: ${alt}` : ""}]
            </span>
          ),
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
