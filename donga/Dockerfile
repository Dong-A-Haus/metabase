# Đông A's Metabase image (DONGA.md): upstream's own image for this version, with its jar swapped for the jar built
# from this fork. Everything else (JRE, fonts, certificates, run_metabase.sh, the entrypoint) stays upstream's, so
# rolling back is only pointing compose back at the FROM image below.
#
# Built by .github/workflows/donga.yml with the build context holding metabase.jar (from ./bin/build.sh).
FROM metabase/metabase:v0.65.2@sha256:b62ac14872e9992d28218a2264d99484e0707064aae9fb594d8fbb3bc1518a9e

COPY metabase.jar /app/metabase.jar
