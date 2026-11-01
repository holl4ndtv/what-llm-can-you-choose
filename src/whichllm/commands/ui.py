"""``whichllm ui``: start the local web UI."""

from __future__ import annotations

import typer


def ui_command(*, port: int, open_browser: bool) -> None:
    from whichllm.ui.server import serve

    if not 1 <= port <= 65535:
        raise typer.BadParameter("port must be between 1 and 65535")
    try:
        serve(port=port, open_browser=open_browser)
    except OSError as exc:
        typer.echo(f"Could not start on 127.0.0.1:{port}: {exc}", err=True)
        raise typer.Exit(code=1)
