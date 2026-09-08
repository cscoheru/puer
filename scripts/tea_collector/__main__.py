"""
Entry point for running tea-collector as a module:
    python -m tea_collector.pipeline --adapter tieba ...
"""

from .pipeline import main

if __name__ == "__main__":
    main()
