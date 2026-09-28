---
title: Deep dive
date: 2024-04-02
author: ada
tags: [deep]
---

In a subdirectory, so its id keeps the `nested/` prefix and it sorts *between* its
two siblings rather than after them. That ordering is the whole reason the scan is
sorted: filesystem order is a per-volume hash, and a page listing this collection
would otherwise render differently on a different machine — or on a different host.
