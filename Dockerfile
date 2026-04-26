FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency resolution.
RUN pip install --no-cache-dir uv

# Copy only what's needed to install deps first, for layer caching.
COPY pyproject.toml ./
RUN uv pip install --system --no-cache .

# Copy the rest.
COPY . .

EXPOSE 8787
CMD ["python", "app.py"]
