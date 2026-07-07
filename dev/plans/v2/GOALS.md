# v2 Goals

This document outlines the goals for the v2 version of the app.

## App-Wide

Make the app light themed. Disable the option for a dark theme.

## Server Gallery

The desktop app landing page should look like [this](Landing.png).

### Header

The header should contain:

1. "LocalCoast" wordmark logo
2. Search bar (for searching for servers by name)
3. Chevron Dropdown: "Framework" (for filtering by framework, supports multi-select)
4. Chevron Dropdown: "Category" (for filtering by category (Frontend, Backend, Fullstack), supports multi-select)
5. Chevron Sort: "Sort by" (for sorting servers. Servers are ordered from left-to-right, then wraps top to bottom.) Options:
  - A-Z
  - Z-A
  - Newest First (total runtime)
  - Longest Running (total runtime)
  - "Most Intensive" (CPU/RAM usage)
  - "Least Intensive" (CPU/RAM usage)

### Server Grid

Server cards are rendered in a layout grid with four columns and infinite rows. Servers are ordered from left-to-right, then wraps top to bottom.

#### Server Card

A server card should contain:

1. Preview Image (of the server localhost page. If the preview is a JSON output, show a black "{/}" instead)
  - Top right corner: Type badge ("FRONTEND": purple, "BACKEND": green, "FULLSTACK": purple. The type badge should be derived from the framework used on the server.)
3. Server details (ordered left to right)
  - Framework icon (e.g. React, Vue, Express). 
  - Server name (derived from `name` from server's `package.json` file. If not available, use the directory's name. If the directory's name is `src`, `backend`, `frontend`, or any other technical word not related to the project name, then `cd ..` to the parent directory and use that name instead until you find the project name. The server name text size should be resized to fit within a set width. Never allow the server name to overflow or force other components to move/reshape).
    - Good: 'gopher', 'volero', 'outreach'
    - Bad: 'src', 'backend', 'frontend'
  - Server port: the url of the active port (e.g. `http://localhost:3000`)
  - Ellipsis: lucide icon 'Ellipsis' (clicking this should open a dropdown with server actions). Server actions:
    - Open: Opens the server in the browser
    - Code: Opens the server's code in the editor
    - Kill: terminates the server process
