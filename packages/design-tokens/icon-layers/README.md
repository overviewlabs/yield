# WHOX Treasury icon source

These three transparent SVG files are ordered back-to-front and sized on Apple's 1024 × 1024 iPhone, iPad, and Mac canvas. They are intentionally free of masks, shadows, blurs, gradients, and specular effects so those properties remain editable in Icon Composer.

Import the numbered files into an Icon Composer document named `AppIcon`, keep them in at most three groups, set the document background to midnight navy (`#071231`), and annotate Default, Dark, and Mono appearances. The operating system applies the enclosure mask; do not add another rounded-square mask to these layers.

The mark combines a treasury dial, a compass-like control surface, and a directional path. It contains no text, brokerage marks, currency marks, or performance promise. `concept-vault-compass.png` records the built-in image-generator exploration used to evaluate the direction; the numbered vectors are the simplified, deterministic, production-editable source, and `AppIcon-1024.png` is the opaque fallback.

Icon Composer currently requires a compatible macOS release. If it isn't available, the iOS target uses the checked-in flattened `AppIcon` asset until an `.icon` file is exported on a supported design workstation.
