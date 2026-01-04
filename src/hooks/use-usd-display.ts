import { useState, useEffect } from "react";

const STORAGE_KEY = "wf:usd-display";
const EVENT_NAME = "wf:usd-display-changed";

export interface UsdDisplayHook {
  isUsdDisplay: boolean;
  toggleUsdDisplay: () => void;
}

export function useUsdDisplay(): UsdDisplayHook {
  const [isUsdDisplay, setIsUsdDisplay] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    // Listen for localStorage changes from other tabs/windows
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue !== null) {
        try {
          setIsUsdDisplay(JSON.parse(e.newValue));
        } catch {
          setIsUsdDisplay(false);
        }
      }
    };

    // Listen for in-document changes (same window) via custom event
    const handleLocalEvent = (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail as { isUsdDisplay?: boolean } | undefined;
        if (detail && typeof detail.isUsdDisplay === "boolean") {
          setIsUsdDisplay(detail.isUsdDisplay);
        }
      } catch {
        // no-op
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(EVENT_NAME, handleLocalEvent as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(EVENT_NAME, handleLocalEvent as EventListener);
    };
  }, []);

  const toggleUsdDisplay = () => {
    const newValue = !isUsdDisplay;
    setIsUsdDisplay(newValue);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newValue));

    // Notify other hook instances in the same window immediately
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { isUsdDisplay: newValue } }));
    } catch {
      // no-op
    }
  };

  return {
    isUsdDisplay,
    toggleUsdDisplay,
  };
}
