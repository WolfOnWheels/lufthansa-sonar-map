# Lufthansa Sonar Map

Live map of airborne Lufthansa (LH) flights (data: [AirLabs API](https://airlabs.co)), set to three synchronized audio tracks.

- `index.html`: flat map with octilinear coastlines. Flights glow by altitude layer (Ground 0–450 m lime, Between 450–10,000 m yellow, Air above 10,000 m cyan). Each note of the Between track flashes the ring of one random Between flight and shows its flight number and route.
- `map.html`: map only, with zoom and play/pause controls.
- `panel.html`: map with an info panel per altitude layer (aircraft counts; ascending/descending in the Between layer).
- `mockup.html`: the map shown on a digital display in an airport lounge.

Shared code lives in `sonar.js` and `sonar.css`.

Press Play to start the audio; each track has its own volume control.
