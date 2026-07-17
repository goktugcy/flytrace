'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group, Points as ThreePoints } from 'three';

/**
 * Low-poly rotating globe with orbiting "traffic" points (docs/03/04 hero). Pure
 * WebGL via React Three Fiber — mounted only when WebGL is available and the
 * viewer hasn't asked for reduced motion (see Hero). `animate=false` renders a
 * still frame so a reduced-motion viewer still gets the 3D visual, not motion.
 */
export function Hero3DScene({ animate }: { animate: boolean }) {
  return (
    <Canvas
      camera={{ position: [0, 0, 3.2], fov: 50 }}
      style={{ width: '100%', height: '100%' }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <ambientLight intensity={0.6} />
      <pointLight position={[4, 4, 4]} intensity={1.2} />
      <Globe animate={animate} />
    </Canvas>
  );
}

function Globe({ animate }: { animate: boolean }) {
  const group = useRef<Group>(null);
  const traffic = useRef<ThreePoints>(null);

  // Fixed pseudo-random traffic points on a sphere shell (deterministic → stable SSR-free render).
  const positions = useMemo(() => {
    const n = 400;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      // Fibonacci sphere for even distribution.
      const t = i / n;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 1.35;
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, []);

  useFrame((_, delta) => {
    if (!animate) return;
    if (group.current) group.current.rotation.y += delta * 0.12;
    if (traffic.current) traffic.current.rotation.y -= delta * 0.05;
  });

  return (
    <group ref={group} rotation={[0.4, 0, 0.1]}>
      {/* Solid globe */}
      <mesh>
        <sphereGeometry args={[1.2, 48, 48]} />
        <meshStandardMaterial color="#0e2038" roughness={0.9} metalness={0.1} />
      </mesh>
      {/* Wireframe overlay for the "graticule" look */}
      <mesh>
        <sphereGeometry args={[1.205, 24, 24]} />
        <meshBasicMaterial color="#2a4a72" wireframe transparent opacity={0.5} />
      </mesh>
      {/* Orbiting traffic */}
      <points ref={traffic}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#4fd1c5" size={0.035} sizeAttenuation transparent opacity={0.9} />
      </points>
    </group>
  );
}
