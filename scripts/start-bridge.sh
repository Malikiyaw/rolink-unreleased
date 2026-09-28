#!/bin/bash
# RoLink Bridge Starter (Unix)
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
python3 bridge.py
