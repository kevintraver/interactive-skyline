# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People exploring how a city skyline would look without particular tall buildings or with those buildings moved. The primary experience is quick visual exploration. Editing controls appear when needed rather than occupying a persistent workspace.

## Product Purpose

Interactive Skyline presents true-scale three.js models of Salt Lake City and Las Vegas. Visitors can hide or move tall buildings and inspect the resulting skyline.

## Capabilities and Constraints

The existing app includes city switching, viewpoint thumbnails, building search, building selection, hide/show, move, undo, start over, day/night, aerial imagery, height highlighting, height threshold, and feet/meters. Existing mouse and touch navigation remains available.

The user chose the Open view redesign, with a full-screen skyline and compact grouped navigation. It must make pan and zoom discoverable with visible controls. Camera navigation and resetting building changes are separate actions. Building editing uses one compact contextual editor, persistent Undo, and one More menu for building details and secondary actions. One separate global Start over control restores all buildings and clears edit history, leaving camera and settings alone. Other panels disappear during a building drag.

## Evidence on Hand

README.md describes the capabilities, data sources, and known accuracy limits. data/cities.json defines cities and viewpoints. public/data contains the built scene data. The existing application uses real terrain, aerial imagery, and building footprints.

## Open Decisions

Open view and the building editing behavior are approved. Deployment requires a separate instruction. Detailed behavior is recorded in docs/plans/04-ui-redesign.md.
