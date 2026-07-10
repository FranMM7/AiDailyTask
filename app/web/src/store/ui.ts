import { create } from "zustand";

export type Theme = "dark" | "light";
export type ColorBy = "category" | "severity";
export type SseStatus = "connecting" | "open" | "error";

interface UiState {
  theme: Theme;
  colorBy: ColorBy;
  colorByInitialized: boolean;
  sseStatus: SseStatus;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setColorBy: (colorBy: ColorBy) => void;
  /** Seed colorBy from config.card once (does not clobber a user override). */
  seedColorBy: (colorBy: ColorBy) => void;
  setSseStatus: (status: SseStatus) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: "dark",
  colorBy: "category",
  colorByInitialized: false,
  sseStatus: "connecting",
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set({ theme: get().theme === "dark" ? "light" : "dark" }),
  setColorBy: (colorBy) => set({ colorBy, colorByInitialized: true }),
  seedColorBy: (colorBy) => {
    if (!get().colorByInitialized) set({ colorBy, colorByInitialized: true });
  },
  setSseStatus: (sseStatus) => set({ sseStatus }),
}));
