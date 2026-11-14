#!/bin/sh
set -eu
wget --quiet --tries=1 --spider http://127.0.0.1:3000/health
