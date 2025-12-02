// store/spots.ts
import { create } from "zustand";

export type Spot = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  description?: string;
  address?: string;
  imageUrl?: string;
  rating?: number;
  stayMinutes?: number;
};

type SpotStore = {
  spots: Spot[];
  setSpots: (spots: Spot[]) => void;
  clearSpots: () => void;
};

export const useSpotStore = create<SpotStore>((set) => ({
  spots: [],
  setSpots: (spots) => set({ spots }),
  clearSpots: () => set({ spots: [] }),
}));

