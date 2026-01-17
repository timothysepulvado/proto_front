#!/bin/bash
# Setup script for the BrandStudios OS HUD Worker

echo "Setting up HUD Worker..."

# Create virtual environment
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

# Activate and install dependencies
echo "Installing dependencies..."
source .venv/bin/activate
pip install -r requirements.txt

echo ""
echo "Setup complete!"
echo ""
echo "To run the worker:"
echo "  source .venv/bin/activate"
echo "  python worker.py"
echo ""
echo "Make sure the HUD is running at http://localhost:5173"
