"""Tiny demonstration of creating code through a voice conversation."""


def greet(name: str = "world") -> str:
    return f"Hello, {name}! This file was created through a voice conversation."


if __name__ == "__main__":
    print(greet())
