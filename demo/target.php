<?php

class Target
{
    public function hello(): string
    {
        return "line 3 is the class declaration above — this is where @see ./demo/target.php:3 should land";
    }
}
