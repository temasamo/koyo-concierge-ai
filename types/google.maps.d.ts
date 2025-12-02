/// <reference types="@googlemaps/js-api-loader" />

declare global {
  interface Window {
    google: typeof google;
  }
}

export {};

