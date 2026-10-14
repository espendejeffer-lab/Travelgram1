# TravelGram

Class travel-story website for 10E5, 9E6, 7E3, 7E4 and 6E7, hosted on Netlify.

- `site/` – the website (page, Story Guide audio, model story videos)
- `netlify/functions/api.mjs` – saves posts, comments, videos and results (Netlify Blobs)
- `netlify.toml`, `package.json` – settings Netlify reads when it publishes the site

No student names or ID numbers are stored in this repository. Class lists are imported
from the private setup file in **Teacher → Class → Import setup file**.

The teacher password is set in Netlify (environment variable `TEACHER_PASSWORD`) and can be
changed later in **Teacher → Class → Teacher password**.
