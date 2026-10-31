"""A simple Snake game using Python's built-in tkinter library.

Run: python experiments/snake.py
Requires a desktop environment with tkinter support.
"""
import random
import tkinter as tk

CELL = 24
GRID = 20
SIZE = CELL * GRID
DELAY_MS = 120


class SnakeGame:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Snake - Voice Experiment")
        self.canvas = tk.Canvas(self.root, width=SIZE, height=SIZE, bg="#151a20", highlightthickness=0)
        self.canvas.pack()
        self.label = tk.Label(self.root, text="Arrow keys / WASD to move · Space to restart", pady=8)
        self.label.pack()
        self.root.bind("<KeyPress>", self.on_key)
        self.reset()
        self.tick()

    def reset(self):
        mid = GRID // 2
        self.snake = [(mid, mid), (mid - 1, mid), (mid - 2, mid)]
        self.direction = (1, 0)
        self.next_direction = self.direction
        self.score = 0
        self.game_over = False
        self.food = self.new_food()
        self.draw()

    def new_food(self):
        free = [(x, y) for x in range(GRID) for y in range(GRID) if (x, y) not in self.snake]
        return random.choice(free) if free else None

    def on_key(self, event):
        if event.keysym == "space" and self.game_over:
            self.reset()
            return
        directions = {
            "Up": (0, -1), "w": (0, -1),
            "Down": (0, 1), "s": (0, 1),
            "Left": (-1, 0), "a": (-1, 0),
            "Right": (1, 0), "d": (1, 0),
        }
        candidate = directions.get(event.keysym)
        if candidate and candidate != (-self.direction[0], -self.direction[1]):
            self.next_direction = candidate

    def tick(self):
        if not self.game_over:
            self.direction = self.next_direction
            x, y = self.snake[0]
            dx, dy = self.direction
            head = (x + dx, y + dy)
            eating = head == self.food
            body = self.snake if eating else self.snake[:-1]
            if not (0 <= head[0] < GRID and 0 <= head[1] < GRID) or head in body:
                self.game_over = True
            else:
                self.snake.insert(0, head)
                if eating:
                    self.score += 1
                    self.food = self.new_food()
                    if self.food is None:
                        self.game_over = True
                else:
                    self.snake.pop()
            self.draw()
        self.root.after(DELAY_MS, self.tick)

    def draw(self):
        self.canvas.delete("all")
        if self.food:
            x, y = self.food
            self.canvas.create_oval(x * CELL + 4, y * CELL + 4,
                                    (x + 1) * CELL - 4, (y + 1) * CELL - 4,
                                    fill="#ff726f", outline="")
        for i, (x, y) in enumerate(self.snake):
            self.canvas.create_rectangle(x * CELL + 2, y * CELL + 2,
                                         (x + 1) * CELL - 2, (y + 1) * CELL - 2,
                                         fill="#9de58a" if i == 0 else "#4abf77", outline="")
        self.label.config(text=f"Score: {self.score}   |   Arrow keys / WASD to move")
        if self.game_over:
            self.canvas.create_text(SIZE // 2, SIZE // 2, text="GAME OVER",
                                    fill="white", font=("Arial", 28, "bold"))
            self.canvas.create_text(SIZE // 2, SIZE // 2 + 35, text="Press Space to restart",
                                    fill="white", font=("Arial", 13))

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    SnakeGame().run()
