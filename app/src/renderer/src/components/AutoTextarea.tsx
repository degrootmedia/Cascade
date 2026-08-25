/**
 * Textarea that grows/shrinks to fit its content as the user types (and when
 * the value changes programmatically, e.g. after an AI refinement). Beyond
 * `maxHeight` it scrolls internally instead of stretching the layout forever.
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow at most this tall (px) before inner scrolling kicks in. 0 = uncapped. */
  maxHeight?: number;
}

export const AutoTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoTextarea({ maxHeight = 0, ...props }, outerRef) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outerRef, () => ref.current as HTMLTextAreaElement);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const want = el.scrollHeight;
    if (maxHeight > 0 && want > maxHeight) {
      el.style.height = `${maxHeight}px`;
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${want}px`;
      el.style.overflowY = "hidden";
    }
  });
  return <textarea ref={ref} rows={1} {...props} />;
});
