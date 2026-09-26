"""Connector error types shared by the broker and connectors."""


class ToolTimeout(Exception):
    """Transport timeout; after dispatch of a write this means the effect is UNKNOWN."""


class ToolFailure(Exception):
    """Connector reported a failure."""
