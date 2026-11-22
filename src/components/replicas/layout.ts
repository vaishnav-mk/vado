// Each row is its own grid with fixed tracks, so strips line up across rows. On a phone the name and numbers
// share a line and the strip gets the full width under them.
export const ROW =
  "grid grid-cols-[minmax(0,1fr)_4rem_4rem] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[13rem_minmax(0,1fr)_4.5rem_4.5rem]";

export const STRIP = "col-span-3 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1";
export const LAG = "col-start-2 row-start-1 text-right sm:col-start-3";
export const READS = "col-start-3 row-start-1 text-right sm:col-start-4";
