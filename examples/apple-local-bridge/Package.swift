// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "apple-local-bridge",
    platforms: [
        .macOS("26.0")
    ],
    products: [
        .executable(name: "apple-local-bridge", targets: ["apple-local-bridge"])
    ],
    targets: [
        .executableTarget(name: "apple-local-bridge")
    ]
)
