import errno

import pytest
import typer

from whichllm.commands.ui import ui_command


def test_busy_port_falls_back_to_next_free_port(monkeypatch, capsys):
    tried = []

    def fake_serve(port, open_browser):
        tried.append(port)
        if port < 8767:
            raise OSError(errno.EADDRINUSE, "Address already in use")

    monkeypatch.setattr("whichllm.ui.server.serve", fake_serve)
    ui_command(port=8765, open_browser=False)
    assert tried == [8765, 8766, 8767]
    assert "8765 is busy" in capsys.readouterr().err


def test_other_errors_still_fail(monkeypatch):
    def fake_serve(port, open_browser):
        raise OSError(errno.EACCES, "Permission denied")

    monkeypatch.setattr("whichllm.ui.server.serve", fake_serve)
    with pytest.raises(typer.Exit):
        ui_command(port=8765, open_browser=False)
