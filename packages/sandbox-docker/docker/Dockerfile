# Optional image for createDockerSandboxEnvironment({ image, user: "1000:1000" }).
# The default configuration uses the public alpine:3.21 image and user 65534:65534.
FROM alpine:3.21

RUN adduser -D -u 1000 -h /tmp sandbox \
  && mkdir -p /workspace \
  && chown 1000:1000 /workspace

USER 1000:1000
WORKDIR /workspace
CMD ["/bin/sh", "-c", "while true; do sleep 3600; done"]
