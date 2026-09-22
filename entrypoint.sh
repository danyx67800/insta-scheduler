#!/bin/sh
# Entrypoint: ripara i permessi del volume dati, poi droppa i privilegi.
#
# Su Umbrel ${APP_DATA_DIR}/data viene montato su /data come root,
# sovrascrivendo la cartella preparata in build: senza questo chown
# l'utente `app` non può crearci scheduler.db e uploads/ (EACCES).
set -eu

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/uploads"
chown -R app:app "$DATA_DIR"

exec su-exec app "$@"
