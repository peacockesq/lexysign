from __future__ import annotations


class FirmMcpError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"lexysign_mcp:{code}: {message}")
        self.code = code
        self.detail = message
