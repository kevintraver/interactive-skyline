# City models: CityGML, CityJSON and 3DCityDB

Many cities publish semantic 3D building models (CityGML or CityJSON) with true footprints, measured heights
and, at LOD2, real roof shapes. When one covers the landmark, it beats reading proportions off photos: take
the geometry from it and spend the photo work on color, facade detail and night light.
Contents: [finding data](#finding-data) · [citymodel.py](#citymodelpy) · [3DCityDB](#3dcitydb-v5) ·
[using it in a build](#using-it-in-a-build) · [limits](#limits)

## Finding data

- [Awesome CityGML](https://github.com/OloOcki/awesome-citygml): open 3D city models from 21+ countries and
  65+ cities (Germany nation-wide LOD1/LOD2, Netherlands' 3D BAG, New York, Helsinki, Vienna, Singapore, ...).
- 3D BAG (the whole Netherlands, LOD 1.2/1.3/2.2): an OGC API that answers with CityJSON features, e.g.
  `https://api.3dbag.nl/collections/pand/items?bbox=84600,447000,85000,447400&limit=40` (EPSG:7415 meters).
  Save the response to a file; `citymodel.py` reads it as is.
- No city model for the area (the US Southwest, including Las Vegas, has none as of this writing)? Use
  OpenStreetMap footprints and project data (`skyline_tool.py footprint`) as usual.

## citymodel.py

Pure Python, no database needed:

```
python <skill>/scripts/citymodel.py list    tile.city.json --near 84990,447270 --limit 10
python <skill>/scripts/citymodel.py extract tile.city.json --id NL.IMBAG.Pand.0503100000000033 --out footprint.json [--lod 2.2]
```

- Reads CityJSON (1.x/2.0), CityJSONSeq (`.jsonl`) and OGC API collections of CityJSONFeatures.
- `list` shows each building's id, height (from `measuredHeight`, `height` or the 3D BAG's attributes, else the
  geometry's extent), center in the file's CRS, and available LODs (counting its BuildingParts).
- `extract` writes footprint.json in the kit's frame (meters east/north of the building's center, heights above
  its ground): `volumes` with the LOD0 or ground outline, and `surfaces` with every polygon of the chosen LOD
  and its semantic type (`RoofSurface`, `WallSurface`, `GroundSurface`, ...). `--origin X,Y` sets the origin
  explicitly (e.g. to match where an app places the model).
- The data must be in a projected CRS in meters; geographic (lat/lon) files are refused.
- CityGML (XML) is not parsed directly: load it into a 3DCityDB and export CityJSON, or convert it with
  citygml-tools.

## 3DCityDB v5

[3DCityDB](https://github.com/3dcitydb/3dcitydb) is a PostgreSQL/PostGIS schema for CityGML 3.0 (and 2.0/1.0)
city models, with [citydb-tool](https://github.com/3dcitydb/citydb-tool) to import and export
CityGML/CityJSON. Use it when the data is CityGML, very large, or already lives in a database. Documentation:
https://docs.3dcitydb.org/1.3/ (suite 1.3 = database v5 + citydb-tool). Requires Docker for the commands below.

Start a database (SRID = the data's EPSG code; both variables are required):

```
docker run --name citydb -p 5432:5432 -d -e POSTGRES_PASSWORD=<password> -e SRID=<EPSG code> 3dcitydb/3dcitydb-pg:5
```

Import CityGML or CityJSON (mount the data folder at /data; `import cityjson` for CityJSON):

```
docker run --rm -v "<data folder>:/data" 3dcitydb/citydb-tool import citygml -H <host> -d postgres -u postgres -p <password> /data/city.gml
```

Export the buildings you need as CityJSON, then use `citymodel.py` on the file (`citymodel.py from-3dcitydb` runs
this for you, reading connection details from options or `CITYDB_HOST`, `CITYDB_NAME`, `CITYDB_USERNAME`,
`CITYDB_PASSWORD`, and never printing the password):

```
docker run --rm -v "<out folder>:/data" 3dcitydb/citydb-tool export cityjson --type-name=bldg:Building \
    --filter="con:height > 100" -H <host> -d postgres -u postgres -p <password> -o /data/tall.city.json
```

Filters: `--filter` takes CQL2 on feature properties (`con:height > 15`); `--sql-filter` takes a query that
returns feature ids (`SELECT id FROM feature WHERE objectid IN ('ABC', 'DEF')`). citydb-tool exports only
CityGML and CityJSON (no glTF or 3D Tiles), so the kit does the Blender side.

Schema notes, for direct SQL (v5 differs completely from v4): every city object is a row in `feature`
(`objectid`, `objectclass_id`, `envelope`); its class is in `objectclass` (`classname = 'Building'`); attributes
are rows in `property` (`name`, `val_double`, `val_string`, `val_uom`, `val_geometry_id`, `val_lod`, with
`parent_id` for nested values); geometries are PostGIS geometries in `geometry_data.geometry`. A building's
height is a `height` property whose child row named `value` holds the number. Untested sketch:

```sql
SELECT f.objectid, v.val_double AS height_m
FROM citydb.feature f
JOIN citydb.property h ON h.feature_id = f.id AND h.name = 'height' AND h.parent_id IS NULL
JOIN citydb.property v ON v.parent_id = h.id AND v.name = 'value'
WHERE f.objectclass_id = (SELECT id FROM citydb.objectclass WHERE classname = 'Building')
ORDER BY v.val_double DESC LIMIT 25;
```

Prefer the CityJSON export for geometry: it is documented and stable, while the per-LOD property names are not.

## Using it in a build

```python
fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
COLORS = {"Wall": "D8D2C4", "Roof": "5A5550", "Ground": "777777", "Glass": "26303A"}

def build():
    b = kit.Builder(COLORS, glow, windows={"Wall": 0.6})
    b.surfaces(fp["surfaces"], {"WallSurface": "Wall", "RoofSurface": "Roof", "GroundSurface": "Ground"}, default="Wall")
    # add what the city model lacks: crown lights, signage-free panels, fins, a spire...
    return b.finish("Building")
```

`Builder.surfaces` snaps corners within 1 mm into shared vertices, so a closed LOD solid stays closed, and
returns how many polygons it skipped as degenerate. For interactive-skyline, the city model's origin and the
app's footprint center differ: pass `--origin` with the app building's center converted to the file's CRS, or
start with offset 0,0 and correct it from `skyline_tool.py check` screenshots.

## Limits

- Polygon holes (courtyards, LOD3 window openings) are dropped; the mesh check then reports a few open edges.
- LOD2 walls arrive as hundreds of small polygons: check the triangle budget, and use LOD 1.2/1.3 for distant
  buildings.
- Facade colors and night light are not in the data; set them from photos as usual. Never take logos or signs
  from textured LOD3 models.
