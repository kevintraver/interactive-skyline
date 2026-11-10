# Interactive Skyline

**[interactive-skyline.vercel.app](https://interactive-skyline.vercel.app)**

A true-scale 3D model of the Salt Lake City and Las Vegas skylines, built with three.js. Hide or move the tall buildings to see what each skyline would look like without them, or with them somewhere else.

![Salt Lake City from Ensign Peak](docs/salt-lake-city.png)

![Las Vegas from the east](docs/las-vegas.png)

## What you can do

- **Hide a building.** Click a blue building to select it, then press Hide. Right-click gives the same option, plus "Hide this and everything taller".
- **Move a building.** Drag a selected building along the ground. Its real footprint stays marked so you can see where it came from.
- **Undo and reset.** Cmd+Z undoes the last change. "Reset position" puts one building back, and "Reset all" restores everything.
- **Find a building.** Search the list and click a row to center the view on it.
- **Switch city and viewpoint.** Each city has an eye-level view and an aerial one.
- **Change the rules.** Settings control the height cutoff for removable buildings, what a click does, units, and whether the aerial photo is shown.

![The Sphere moved across the Strip](docs/moved.png)

## Run it

```sh
pnpm install
pnpm dev
```

The built data in `public/data` is checked in, so the app runs without the data pipeline.

## How the model is built

One unit is one meter. Every building sits on real terrain at its real position.

| Layer | Source |
| --- | --- |
| Footprints, names, tagged heights | OpenStreetMap, via the Overpass API |
| Measured heights | USGS 3DEP LiDAR point clouds (Salt Lake City 2013, Las Vegas 2022) |
| Terrain | USGS 3DEP elevation, via AWS Terrain Tiles |
| Ground imagery | USGS NAIP aerial photography |

Each building's height comes from the most trustworthy source available, in this order:

1. An explicit `height` tag in OpenStreetMap.
2. Roof minus ground, measured from the LiDAR point cloud.
3. Floor count times 3.2 m, when LiDAR is missing or predates the building.
4. A flat 4 m guess when nothing is known.

Most buildings use LiDAR: 18,136 of 18,844 in Salt Lake City and 17,506 of 17,861 in Las Vegas.

Two things keep the LiDAR honest around towers. The Las Vegas survey files every return above roughly 150 m as noise, which cuts the top off the tallest towers, so the build takes those returns back where they are dense enough to be a roof. And a low building that touches a tower is measured without the tower's footprint, so a podium does not inherit the height of the tower standing on it.

The pipeline is four Python scripts, run with [uv](https://docs.astral.sh/uv/). Each takes a city id from `public/data/cities.json`:

```sh
uv run scripts/fetch_lidar.py lv       # download and rasterize the point cloud (slow, about 1 GB)
uv run scripts/build_terrain.py lv     # terrain height grids
uv run scripts/build_imagery.py lv     # aerial photo draped on the terrain
uv run scripts/build_buildings.py lv   # footprints + heights -> public/data/lv/buildings.json
```

`pnpm data` runs all four for both cities. The raw OpenStreetMap extract for each city is expected at `data/raw/<city>/osm-buildings.json`; the scripts do not download it.

To add a city, add an entry to `public/data/cities.json` (origin, bounding box, LiDAR dataset, terrain extents and viewpoints) and run the pipeline for it.

## How accurate it is

Checked for Salt Lake City:

- **Heights.** Nine of the ten tallest buildings listed by CTBUH are within 0.5% of the listed height. The LiDAR independently agrees with the tagged heights to within about 5% for towers that existed in 2013, with one exception: it reads Beneficial Tower about 9% low.
- **Datum.** LiDAR ground and the terrain model differ by a constant 17.2 m (the two use different vertical datums), with a spread of under half a meter. The build corrects for it.
- **View.** A render matched to a 2020 photo from Ensign Peak shows the same mountain profile, street axis and tower order. The camera position was estimated, so this is a visual check only.

![Photo and model compared](docs/photo-match.png)

Las Vegas was checked against Wikipedia's list of its tallest buildings, matched by location. All 44 buildings on the list are within 6% of the published height except Marriott's Grand Chateau (114 m against 128 m) and Panorama Tower I (120 m against 128 m), where the model follows the LiDAR. With the noise returns restored, the LiDAR independently agrees with the tagged heights of the tallest towers (Fontainebleau, the Palazzo, Encore, the Cosmopolitan, Aria) to within about 3%. Las Vegas has not had a photo check.

Known limits:

- Buildings are extruded footprints. Pyramids and domes are drawn where OpenStreetMap tags them (Luxor, the Sphere, the Utah Capitol); everything else has a flat roof.
- The Strat is drawn by hand, because only its outline is mapped: the pod, crown and mast are sized from the LiDAR, the legs are estimated. The Las Vegas Eiffel Tower is drawn as a pyramid.
- Buildings finished after the LiDAR survey have estimated heights unless OpenStreetMap tags one. They are marked "est." in the list.
- Hand corrections to wrong or missing OpenStreetMap data are listed, with reasons, in `data/overrides.json`.
- 3D buildings cover only the core of each city. Beyond that the ground is imagery.

## License

The code is released under the [MIT License](LICENSE).

The data and images are not covered by it and keep their own terms:

- `public/data/*/buildings.json` is derived from OpenStreetMap and is available under the [Open Database License](https://opendatacommons.org/licenses/odbl/).
- Terrain and ground imagery in `public/data` come from USGS sources in the public domain.
- `docs/photo-match.png` includes a CC BY-SA 4.0 photo, credited below.

## Credits

- Building data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the Open Database License.
- LiDAR, elevation and NAIP imagery from the U.S. Geological Survey, public domain.
- Comparison photo: "Salt Lake City skyline (2020) from Ensign Peak" by Iansmh98, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), via Wikimedia Commons.
