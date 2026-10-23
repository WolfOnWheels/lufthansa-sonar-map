# Lufthansa Sonar Map

Live map of airborne Lufthansa (LH) flights (data: [AirLabs API](https://airlabs.co)), set to three synchronized audio tracks.

- `index.html`: flat map with octilinear coastlines. Flights glow by altitude layer (Ground 0–450 m lime, Ascending/Descending 450–10,000 m yellow, Cruising above 10,000 m cyan). Ground and Cruising loops play continuously; takeoff (0–300 m), climb tones (450–900, 4,500–5,500, 9,500–10,000 m), descent tones (10,500–10,000, 5,500–4,500, 900–450 m) and landing (300–0 m) play once per flight when the live data shows a plane climbing or descending through that band.
- `map.html`: map only, with zoom and play/pause controls.
- `panel.html`: map with an info panel per altitude layer (aircraft counts; ascending/descending in the Between layer).
- `mockup.html`: the map shown on a digital display in an airport lounge.

Shared code lives in `sonar.js` and `sonar.css`.

Press Play to start the audio; each track has its own volume control.
