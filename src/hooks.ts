import { useCallback, useState } from "react";
import { mediaUrl } from "./api";
import { assetUrl, isLocalAsset } from "./assets";
import type { Project } from "./types";

export function useFileUrl(filePath?: string | null): string {
  return isLocalAsset(filePath) ? assetUrl(filePath) : mediaUrl(filePath);
}

export function useProjectHistory(initial: Project) {
  const [project, setCurrent] = useState(initial);
  const [past, setPast] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const setProject = useCallback((next: Project | ((current: Project) => Project), record = true) => {
    setCurrent((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      if (record && resolved !== current) {
        setPast((items) => [...items.slice(-49), current]);
        setFuture([]);
      }
      return resolved;
    });
  }, []);
  const reset = useCallback((next: Project) => { setCurrent(next); setPast([]); setFuture([]); }, []);
  const undo = useCallback(() => {
    setPast((items) => {
      if (!items.length) return items;
      const previous = items.at(-1)!;
      setCurrent((current) => { setFuture((next) => [current, ...next]); return previous; });
      return items.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((items) => {
      if (!items.length) return items;
      const next = items[0];
      setCurrent((current) => { setPast((previous) => [...previous, current]); return next; });
      return items.slice(1);
    });
  }, []);
  return { project, setProject, reset, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0 };
}
