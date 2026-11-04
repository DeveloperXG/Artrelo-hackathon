import { Fragment } from 'react';

/**
 * Splits a plain-text message into paragraphs on blank lines and drops each
 * line's leading whitespace. Mirrors the email template's renderer
 * (backend/services/notification/templates/vendorOutreachEmail.js) so the
 * landlord's preview, the email and the vendor's page agree.
 */
export function splitMessageParagraphs(text: string): string[][] {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
    .filter((lines) => lines.length > 0);
}

/**
 * A manager's message as real paragraphs rather than one `pre-line` blob: no
 * indented lines and no stray gaps, however the landlord spaced their edit.
 */
export default function MessageParagraphs({
  text,
  className = '',
  paragraphClassName = '',
}: {
  text: string;
  className?: string;
  paragraphClassName?: string;
}) {
  const paragraphs = splitMessageParagraphs(text);
  if (!paragraphs.length) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {paragraphs.map((lines, index) => (
        <p key={index} className={paragraphClassName}>
          {lines.map((line, at) => (
            <Fragment key={at}>
              {at > 0 ? <br /> : null}
              {line}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}
