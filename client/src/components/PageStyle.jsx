import { useEffect } from "react";

// Applies a page's stylesheet only while the page is mounted, so the per-page
// global rules (body, button, h1...) of the original HTML pages don't collide.
export function PageStyle({ css }) {
    return <style>{css}</style>;
}

export function useBodyClass(className) {
    useEffect(() => {
        document.body.classList.add(className);
        return () => document.body.classList.remove(className);
    }, [className]);
}
