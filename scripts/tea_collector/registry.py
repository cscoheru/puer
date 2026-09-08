"""
Adapter registry — standalone module to avoid circular imports.
"""

# Global adapter registry
ADAPTERS = {}


def register_adapter(cls):
    """Decorator to register an adapter class."""
    instance = cls()
    ADAPTERS[instance.name] = instance
    return cls
