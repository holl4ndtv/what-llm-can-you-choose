"""``whichllm ui``: start the local web UI."""

from __future__ import annotations

import errno

import typer

_PORT_TRIES = 30


def ui_command(*, port: int, open_browser: bool) -> None:
    from whichllm.ui.server import serve

    if not 1 <= port <= 65535:
        raise typer.BadParameter("port must be between 1 and 65535")
    for candidate in range(port, min(port + _PORT_TRIES, 65536)):
        try:
            serve(port=candidate, open_browser=open_browser)
            return
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                typer.echo(f"Could not start on 127.0.0.1:{candidate}: {exc}", err=True)
                raise typer.Exit(code=1)
            typer.echo(f"Port {candidate} is busy, trying {candidate + 1}.", err=True)
    typer.echo(f"No free port found from {port} to {candidate}.", err=True)
    raise typer.Exit(code=1)
